import { NextRequest, NextResponse } from 'next/server'
import {
  buildInpaintPlanPrompt,
  buildInpaintTilePrompt,
} from '@/app/lib/editPrompt'
import type { ReferenceImage } from '@/app/lib/app'

const DEFAULT_MODEL = 'google/gemini-3.1-flash-image-preview'

/** Mirror of the same helper in /api/extend/route.ts. */
function extractImageFromAny(node: unknown): string | null {
  if (!node) return null
  const n = node as Record<string, unknown>

  if (Array.isArray(n.images) && n.images.length > 0) {
    for (const img of n.images as Record<string, unknown>[]) {
      const url = (img?.image_url as Record<string, string> | undefined)?.url
      if (url) return url
      if (typeof img?.url === 'string') return img.url
      if (typeof img?.b64_json === 'string') return `data:image/png;base64,${img.b64_json}`
    }
  }

  if (typeof n.b64_json === 'string' && n.b64_json.length > 100)
    return `data:image/png;base64,${n.b64_json}`

  const content = n.content
  if (Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      const partUrl = (part?.image_url as Record<string, string> | undefined)?.url
      if (part?.type === 'image_url' && partUrl) return partUrl
      if (part?.type === 'image' && typeof part?.url === 'string') return part.url
      if (typeof part?.b64_json === 'string') return `data:image/png;base64,${part.b64_json}`
      if (typeof part?.data === 'string' && part.data.length > 100)
        return `data:image/png;base64,${part.data}`
      const inline = part?.inline_data as Record<string, string> | undefined
      if (inline?.data) return `data:${inline.mime_type || 'image/png'};base64,${inline.data}`
    }
  } else if (typeof content === 'string') {
    if (content.startsWith('data:image') || content.startsWith('http')) return content
    if (content.length > 100 && /^[A-Za-z0-9+/=]+$/.test(content.substring(0, 100)))
      return `data:image/png;base64,${content}`
  } else if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.data === 'string') return `data:image/png;base64,${c.data}`
    const inline = c.inline_data as Record<string, string> | undefined
    if (inline?.data) return `data:${inline.mime_type || 'image/png'};base64,${inline.data}`
  }

  return null
}

/**
 * POST /api/edit
 *
 * Dual-purpose inpaint route used for both the Phase 1 global plan and the
 * Phase 2 per-tile refinement passes of the Tiled Inpaint Pipeline.
 *
 * Body:
 *   phase             'plan' | 'refine'
 *   imageDataUrl      string   — low-res masked context crop (plan) or
 *                               full-res tile input with baked plan (refine)
 *   editPrompt        string   — what to do in the masked region
 *   referenceImages?  ReferenceImage[]  — optional reference images
 *   maskDataUrl?      string   — B&W mask (plan phase, text-mask path only)
 *   apiKey?           string   — BYOK OpenRouter key
 *   model?            string   — OpenRouter model id
 *
 * Response:
 *   { resultUrl: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      phase: 'plan' | 'refine'
      imageDataUrl: string
      editPrompt: string
      referenceImages?: ReferenceImage[]
      maskDataUrl?: string
      apiKey?: string
      model?: string
    }

    const { phase, imageDataUrl, editPrompt, referenceImages, maskDataUrl, apiKey, model } = body

    if (!phase || (phase !== 'plan' && phase !== 'refine')) {
      return NextResponse.json(
        { error: 'phase must be "plan" or "refine"' },
        { status: 400 },
      )
    }

    if (!imageDataUrl || !editPrompt?.trim()) {
      return NextResponse.json(
        { error: 'imageDataUrl and editPrompt are required' },
        { status: 400 },
      )
    }

    const openRouterKey =
      typeof apiKey === 'string' && apiKey.trim()
        ? apiKey.trim()
        : process.env.OPENROUTER_API_KEY

    if (!openRouterKey) {
      return NextResponse.json(
        { error: 'OpenRouter API key missing. Add one in Settings.' },
        { status: 401 },
      )
    }

    const modelId =
      typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL

    const prompt =
      phase === 'plan'
        ? buildInpaintPlanPrompt(editPrompt.trim())
        : buildInpaintTilePrompt(editPrompt.trim())

    type ImagePart = { type: 'image_url'; image_url: { url: string } }
    type TextPart = { type: 'text'; text: string }
    type ContentPart = ImagePart | TextPart

    const content: ContentPart[] = [
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ]

    // For the plan phase with a text-generated mask: include the B&W mask so
    // the model has precise pixel-level guidance about which area to fill.
    if (phase === 'plan' && maskDataUrl) {
      content.push({ type: 'image_url', image_url: { url: maskDataUrl } })
    }

    // Append any user-supplied reference images.
    if (Array.isArray(referenceImages)) {
      for (const ref of referenceImages) {
        if (ref.dataUrl) {
          content.push({ type: 'image_url', image_url: { url: ref.dataUrl } })
          if (ref.description?.trim()) {
            content.push({ type: 'text', text: `Reference image note: ${ref.description.trim()}` })
          }
        }
      }
    }

    content.push({ type: 'text', text: prompt })

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': request.headers.get('referer') || 'http://localhost:3000',
        'X-Title': `AI Image Extender - Inpaint (${phase})`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content }],
        max_tokens: 2000,
        temperature: phase === 'plan' ? 0.4 : 0.3,
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      let errorMessage = 'Edit failed'
      try {
        errorMessage =
          (JSON.parse(errBody) as { error?: { message?: string } })?.error?.message ||
          errorMessage
      } catch {
        errorMessage = errBody.slice(0, 500) || errorMessage
      }
      return NextResponse.json({ error: errorMessage }, { status: response.status })
    }

    const data = await response.json() as Record<string, unknown>
    const choices = data.choices as Array<{ message: unknown }> | undefined
    const message = choices?.[0]?.message

    if (!message) {
      return NextResponse.json({ error: 'No message in response' }, { status: 500 })
    }

    const resultUrl = extractImageFromAny(message)

    if (!resultUrl) {
      return NextResponse.json(
        { error: 'The model did not return an image. Try adjusting your prompt.' },
        { status: 500 },
      )
    }

    return NextResponse.json({ resultUrl })
  } catch (error) {
    console.error('Error in edit route:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
