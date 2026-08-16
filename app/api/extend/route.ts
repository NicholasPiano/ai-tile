import { NextRequest, NextResponse } from 'next/server'
import { buildExtendPrompt, buildGlobalPlanningPrompt, buildRegionalPlanningPrompt } from '@/app/lib/extendPrompt'
import { ReferenceImage } from '@/app/lib/app'

// Default model when the client doesn't specify one.
const DEFAULT_MODEL = 'google/gemini-3.1-flash-image-preview'

/**
 * Walk an arbitrary OpenAI/OpenRouter response shape and pull out the first
 * image data URL we can find. Different image-output chat models put the
 * payload in different places (top-level `images[]`, `content[].image_url`,
 * inline_data, raw base64 strings, etc.) so we check all of them.
 */
function extractImageFromAny(node: unknown): string | null {
  if (!node) return null
  const n = node as Record<string, unknown>

  if (Array.isArray(n.images) && n.images.length > 0) {
    for (const img of n.images as Record<string, unknown>[]) {
      const imgUrl = (img?.image_url as Record<string, string> | undefined)?.url
      if (imgUrl) return imgUrl
      if (typeof img?.url === 'string') return img.url
      if (typeof img?.b64_json === 'string') return `data:image/png;base64,${img.b64_json}`
    }
  }

  if (typeof n.b64_json === 'string' && n.b64_json.length > 100) {
    return `data:image/png;base64,${n.b64_json}`
  }

  const content = n.content
  if (Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      const partUrl = (part?.image_url as Record<string, string> | undefined)?.url
      if (part?.type === 'image_url' && partUrl) return partUrl
      if (part?.type === 'image' && typeof part?.url === 'string') return part.url
      const imgData = (part?.image_url as Record<string, string> | undefined)?.data
      if (imgData) return `data:image/png;base64,${imgData}`
      if (typeof part?.b64_json === 'string') return `data:image/png;base64,${part.b64_json}`
      if (typeof part?.data === 'string' && part.data.length > 100) {
        return `data:image/png;base64,${part.data}`
      }
      const inline = part?.inline_data as Record<string, string> | undefined
      if (inline?.data) {
        const mime = inline.mime_type || 'image/png'
        return `data:${mime};base64,${inline.data}`
      }
    }
  } else if (typeof content === 'string') {
    if (content.startsWith('data:image') || content.startsWith('http')) return content
    if (content.length > 100 && /^[A-Za-z0-9+/=]+$/.test(content.substring(0, 100))) {
      return `data:image/png;base64,${content}`
    }
    const urlMatch = content.match(/!\[.*?\]\((.*?)\)/)
    if (urlMatch?.[1]) return urlMatch[1]
  } else if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.data === 'string') return `data:image/png;base64,${c.data}`
    const inlineData = c.inline_data as Record<string, string> | undefined
    if (inlineData?.data) {
      const mime = inlineData.mime_type || 'image/png'
      return `data:${mime};base64,${inlineData.data}`
    }
  }

  return null
}

export async function POST(request: NextRequest) {
  try {
    const {
      expandedCanvas,
      direction,
      extensionAmount,
      customPrompt,
      artStyle,
      chunkInfo,
      useFullContext,
      extensionInfo,
      attempt = 0,
      apiKey,
      model,
      layerRole,
      sceneBrief,
      referenceImages,
      // Three-phase fields
      phase,
      bakedPlanning,
      // Regional-plan fields (hierarchical planning for very large scenes)
      planScope,
      regionIndex,
      regionCount,
      // Aspect-bucket hint for plan calls (padded canvas → model size grid)
      imageConfig,
    } = await request.json() as {
      expandedCanvas: string
      direction: string
      extensionAmount: number
      customPrompt?: string
      artStyle?: string
      chunkInfo?: unknown
      useFullContext?: boolean
      extensionInfo?: unknown
      attempt?: number
      apiKey?: string
      model?: string
      layerRole?: string
      sceneBrief?: string
      referenceImages?: ReferenceImage[]
      /**
       * 'plan'   = global, regional, or per-tile planning pass (Phase 1 or 2).
       * 'refine' = high-res tile generation (Phase 3, default).
       */
      phase?: 'plan' | 'refine'
      /**
       * True when expandedCanvas is the baked tile-slice composite: the grey
       * blank region has been replaced by the low-res planning preview.
       * The refine prompt frames the task as high-res rendering of the preview.
       */
      bakedPlanning?: boolean
      /**
       * 'region' = this 'plan' call is one region of a regionally-planned
       * extension (see groupTilesIntoPlanRegions); switches the prompt to
       * buildRegionalPlanningPrompt. Undefined/other = existing whole-scene
       * or per-tile re-plan behaviour via buildGlobalPlanningPrompt.
       */
      planScope?: 'region'
      regionIndex?: number
      regionCount?: number
      /**
       * OpenRouter image_config for plan calls whose canvas was padded into a
       * standard aspect bucket. Ignored when absent.
       */
      imageConfig?: {
        aspect_ratio?: string
        image_size?: string
      }
    }

    if (!expandedCanvas || !direction || !extensionAmount) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // Prefer client-provided key (BYOK model for open-source use), fall back
    // to env var for local development and hosted demos.
    const openRouterKey = (typeof apiKey === 'string' && apiKey.trim())
      ? apiKey.trim()
      : process.env.OPENROUTER_API_KEY

    if (!openRouterKey) {
      return NextResponse.json(
        { error: 'OpenRouter API key missing. Add one in Settings.' },
        { status: 401 }
      )
    }

    const modelId = (typeof model === 'string' && model.trim()) ? model.trim() : DEFAULT_MODEL
    const hasBakedPlanning = phase !== 'plan' && (bakedPlanning === true)

    // ── Build prompt ─────────────────────────────────────────────────────────
    let prompt: string
    if (phase === 'plan' && planScope === 'region') {
      // Regional plan — one slice of a regionally-planned very-large extension.
      prompt = buildRegionalPlanningPrompt({
        direction: direction as 'up' | 'down' | 'left' | 'right',
        regionIndex: typeof regionIndex === 'number' ? regionIndex : 0,
        regionCount: typeof regionCount === 'number' ? regionCount : 1,
        customPrompt: customPrompt ?? null,
        artStyle: artStyle ?? null,
        sceneBrief: sceneBrief ?? null,
        referenceImages: referenceImages?.map((r) => ({ description: r.description })),
      })
    } else if (phase === 'plan') {
      // Phase 1 (whole-scene global plan) or Phase 2 (per-tile re-plan) —
      // both use the global planning prompt which describes: fill grey,
      // preserve everything else.
      prompt = buildGlobalPlanningPrompt({
        direction: direction as 'up' | 'down' | 'left' | 'right',
        customPrompt: customPrompt ?? null,
        artStyle: artStyle ?? null,
        sceneBrief: sceneBrief ?? null,
        referenceImages: referenceImages?.map((r) => ({ description: r.description })),
      })
    } else {
      // Phase 2 (default): full extend prompt.
      // When bakedPlanning is true the canvas already has the low-res planning
      // preview composited into the extension area — the prompt frames the task
      // as high-res rendering rather than free-form extension into grey space.
      prompt = buildExtendPrompt({
        direction: direction as 'up' | 'down' | 'left' | 'right',
        chunkInfo: (chunkInfo as Parameters<typeof buildExtendPrompt>[0]['chunkInfo']) ?? null,
        useFullContext: !!useFullContext,
        extensionInfo: (extensionInfo as Parameters<typeof buildExtendPrompt>[0]['extensionInfo']) ?? null,
        customPrompt: customPrompt ?? null,
        artStyle: artStyle ?? null,
        layerRole: layerRole ?? null,
        sceneBrief: sceneBrief ?? null,
        attempt,
        referenceImages: referenceImages?.map((r) => ({ description: r.description })),
        hasBakedPlanning,
      })
    }

    // ── Assemble message content ──────────────────────────────────────────────
    type ImagePart = { type: 'image_url'; image_url: { url: string } }
    type TextPart  = { type: 'text'; text: string }
    type ContentPart = ImagePart | TextPart

    const content: ContentPart[] = [
      // IMAGE 1 — working canvas (tile strip, baked composite, or planning map).
      { type: 'image_url', image_url: { url: expandedCanvas } },
    ]

    // IMAGE 2+ (refine) or IMAGE 2+ (plan) — user-supplied reference images.
    // No separate planning guide image: when bakedPlanning is true the planning
    // preview is already composited into IMAGE 1.
    for (const ref of referenceImages ?? []) {
      content.push({ type: 'image_url', image_url: { url: ref.dataUrl } })
    }

    content.push({ type: 'text', text: prompt })

    // Gemini / GPT image models need modalities set for image output. Plan
    // calls that were padded into an aspect bucket also pass image_config so
    // the provider targets that bucket instead of an arbitrary size.
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      max_tokens: 2000,
      temperature: phase === 'plan'
        ? 0.3
        : hasBakedPlanning
        ? (attempt === 0 ? 0.45 : attempt === 1 ? 0.55 : 0.65)
        : (attempt === 0 ? 0.3 : attempt === 1 ? 0.5 : 0.7),
    }

    if (
      phase === 'plan' &&
      imageConfig &&
      typeof imageConfig === 'object' &&
      typeof imageConfig.aspect_ratio === 'string' &&
      imageConfig.aspect_ratio.length > 0
    ) {
      const config: Record<string, string> = {
        aspect_ratio: imageConfig.aspect_ratio,
      }
      if (typeof imageConfig.image_size === 'string' && imageConfig.image_size.length > 0) {
        config.image_size = imageConfig.image_size
      }
      requestBody.image_config = config
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': request.headers.get('referer') || 'http://localhost:3000',
        'X-Title': 'AI Image Extender',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errBody = await response.text()
      let errorMessage = 'Failed to extend image'
      try {
        errorMessage = (JSON.parse(errBody) as { error?: { message?: string } })?.error?.message || errorMessage
      } catch {
        errorMessage = errBody.slice(0, 500) || errorMessage
      }
      console.error('OpenRouter API error:', response.status, errorMessage)
      return NextResponse.json({ error: errorMessage }, { status: response.status })
    }

    const data = await response.json() as Record<string, unknown>
    console.log('=== API Response Structure ===')
    console.log(JSON.stringify(sanitizeForLogging(data), null, 2))

    const choices = data.choices as Array<{ message: unknown }> | undefined
    const message = choices?.[0]?.message
    if (!message) {
      console.error('No message in response')
      return NextResponse.json({ error: 'No message in response' }, { status: 500 })
    }

    const imageUrl = extractImageFromAny(message)

    const msgRecord = message as Record<string, unknown>
    console.log('\n=== Message Content Structure ===')
    console.log('Content type:', msgRecord.content === null ? 'null' : Array.isArray(msgRecord.content) ? 'array' : typeof msgRecord.content)
    console.log('Has images array:', !!(msgRecord.images as unknown[] | undefined)?.length)
    console.log('Image extracted:', !!imageUrl)
    console.log('===============================\n')

    if (!imageUrl) {
      console.error('No image URL found. Message structure:', JSON.stringify(sanitizeForLogging(message), null, 2))
      return NextResponse.json(
        {
          error: 'The model responded without an image. It may not support image extension yet.',
          debug: {
            hasContent: !!msgRecord.content,
            contentType: Array.isArray(msgRecord.content) ? 'array' : typeof msgRecord.content,
          },
        },
        { status: 500 }
      )
    }

    // Echo the assembled prompt so Debug-mode UI can show the exact text
    // that accompanied IMAGE 1 (built server-side; client must not guess).
    return NextResponse.json({ imageUrl, chunkInfo, requestPrompt: prompt })
  } catch (error) {
    console.error('Error in extend route:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

/** Truncate base64 in nested objects so server logs stay readable. */
function sanitizeForLogging(obj: unknown, depth = 0): unknown {
  if (depth > 10) return '[MAX_DEPTH]'
  if (typeof obj === 'string') {
    if (obj.length > 500) return `[STRING_DATA: ${obj.length} chars]`
    if (obj.startsWith('data:image')) return `[DATA_URL: ${obj.length} chars]`
    return obj
  }
  if (Array.isArray(obj)) return obj.map((item) => sanitizeForLogging(item, depth + 1))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const key in obj as Record<string, unknown>) {
      const val = (obj as Record<string, unknown>)[key]
      out[key] = typeof val === 'string' && val.length > 500
        ? `[LONG_STRING: ${val.length} chars]`
        : sanitizeForLogging(val, depth + 1)
    }
    return out
  }
  return obj
}
