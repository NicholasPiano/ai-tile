import { NextRequest, NextResponse } from 'next/server'
import {
  buildGlobalPlanPrompt,
  buildTileRefinementPrompt,
  buildMaskExtractionPrompt,
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
 * Unified inpaint route for all three phases of the Tiled Inpaint Pipeline:
 *
 *   phase: 'plan'
 *     imageDataUrl      — low-res context crop with grey fill + red border
 *     editPrompt        — what to generate inside the red border
 *     referenceImages?  — optional style reference images
 *
 *   phase: 'extract-mask'
 *     sourceContextUrl  — original (clean) low-res context crop
 *     globalPlanUrl     — the 'plan' phase result to compare against
 *
 *   phase: 'refine'
 *     imageDataUrl      — full-res tile with plan content baked in + blue border
 *     editPrompt        — original edit description, passed only as loose context
 *                         (reference images are NOT sent for this phase — the
 *                         blurry plan crop is the only content signal a tile needs)
 *
 * All phases return { resultUrl: string }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      phase: 'plan' | 'extract-mask' | 'refine'
      imageDataUrl?: string
      sourceContextUrl?: string
      globalPlanUrl?: string
      editPrompt?: string
      referenceImages?: ReferenceImage[]
      apiKey?: string
      model?: string
      /** 1-indexed tile position + total tile count, refine phase only. */
      tileIndex?: number
      tileCount?: number
    }

    const {
      phase,
      imageDataUrl,
      sourceContextUrl,
      globalPlanUrl: globalPlanBodyUrl,
      editPrompt,
      referenceImages,
      apiKey,
      model,
      tileIndex,
      tileCount,
    } = body

    if (!phase || !['plan', 'extract-mask', 'refine'].includes(phase)) {
      return NextResponse.json(
        { error: 'phase must be "plan", "extract-mask", or "refine"' },
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

    type ImagePart = { type: 'image_url'; image_url: { url: string } }
    type TextPart = { type: 'text'; text: string }
    type ContentPart = ImagePart | TextPart

    let content: ContentPart[]
    let temperature: number

    if (phase === 'extract-mask') {
      if (!sourceContextUrl || !globalPlanBodyUrl) {
        return NextResponse.json(
          { error: 'sourceContextUrl and globalPlanUrl are required for extract-mask phase' },
          { status: 400 },
        )
      }

      content = [
        { type: 'image_url', image_url: { url: sourceContextUrl } },
        { type: 'image_url', image_url: { url: globalPlanBodyUrl } },
        { type: 'text', text: buildMaskExtractionPrompt() },
      ]
      temperature = 0.1

    } else {
      // 'plan' or 'refine'
      if (!imageDataUrl || !editPrompt?.trim()) {
        return NextResponse.json(
          { error: 'imageDataUrl and editPrompt are required for plan/refine phases' },
          { status: 400 },
        )
      }

      const prompt =
        phase === 'plan'
          ? buildGlobalPlanPrompt(editPrompt.trim())
          : buildTileRefinementPrompt(
              editPrompt.trim(),
              typeof tileIndex === 'number' && typeof tileCount === 'number'
                ? { index: tileIndex, total: tileCount }
                : undefined,
            )

      content = [
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]

      // Reference images only apply to the global plan — they steer overall
      // composition/style. Tiles refine an already-decided blurry preview and
      // must not be pulled back toward the global style brief.
      if (phase === 'plan' && Array.isArray(referenceImages)) {
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
      temperature = phase === 'plan' ? 0.4 : 0.3
    }

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
        temperature,
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
