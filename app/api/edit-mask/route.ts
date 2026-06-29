import { NextRequest, NextResponse } from 'next/server'

/**
 * Build a B&W mask generation prompt for a given description.
 * Kept inline here since the edit-mask route is no longer wired to the main
 * tiled pipeline (mask extraction now happens via /api/edit phase:'extract-mask').
 */
function buildMaskPrompt(description: string): string {
  return [
    'You are a precision image mask generator.',
    '',
    'I will give you an image. Return a black-and-white mask image that is the',
    'EXACT same pixel dimensions as the input.',
    '',
    `WHITE pixels (#FFFFFF): the area that matches "${description}"`,
    'BLACK pixels (#000000): everything else',
    '',
    'Rules:',
    '- Return ONLY the mask image — no text, no explanation, no border',
    '- Same pixel width and height as the input image',
    '- Use clean, hard edges at object boundaries (avoid anti-aliased fades)',
  ].join('\n')
}

const DEFAULT_MODEL = 'google/gemini-3.1-flash-image-preview'

/**
 * Walk an arbitrary OpenAI/OpenRouter response shape and return the first
 * image data URL found. Mirrors the helper in /api/extend/route.ts.
 */
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
 * POST /api/edit-mask
 *
 * Generate a black-and-white mask image from a text description.
 *
 * Body:
 *   contextDataUrl   string  — context region image (selection + strip)
 *   maskDescription  string  — natural-language description of what to mask
 *   apiKey?          string  — BYOK OpenRouter key
 *   model?           string  — OpenRouter model id
 *
 * Response:
 *   { maskUrl: string }      — monochrome mask data URL
 */
export async function POST(request: NextRequest) {
  try {
    const { contextDataUrl, maskDescription, apiKey, model } = await request.json() as {
      contextDataUrl: string
      maskDescription: string
      apiKey?: string
      model?: string
    }

    if (!contextDataUrl || !maskDescription?.trim()) {
      return NextResponse.json(
        { error: 'contextDataUrl and maskDescription are required' },
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

    const prompt = buildMaskPrompt(maskDescription.trim())

    type ImagePart = { type: 'image_url'; image_url: { url: string } }
    type TextPart = { type: 'text'; text: string }
    type ContentPart = ImagePart | TextPart

    const content: ContentPart[] = [
      { type: 'image_url', image_url: { url: contextDataUrl } },
      { type: 'text', text: prompt },
    ]

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': request.headers.get('referer') || 'http://localhost:3000',
        'X-Title': 'AI Image Extender - Mask Generation',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content }],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      let errorMessage = 'Mask generation failed'
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

    const maskUrl = extractImageFromAny(message)

    if (!maskUrl) {
      return NextResponse.json(
        { error: 'The model did not return an image. Try a different description.' },
        { status: 500 },
      )
    }

    return NextResponse.json({ maskUrl })
  } catch (error) {
    console.error('Error in edit-mask route:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
