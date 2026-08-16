/**
 * Aspect-ratio buckets for image models that cannot return arbitrary pixel
 * sizes. Plan maps are padded into the nearest supported bucket before the
 * API call, then the pad is cropped back off the response so tile crops stay
 * registered to the original prototype geometry.
 */

/** Layout of original content inside a padded aspect-bucket canvas. */
export interface AspectPadLayout {
  /** Aspect ratio string sent to the model, e.g. `"4:1"`. */
  aspectRatio: string
  /** Padded canvas width in pixels. */
  paddedWidth: number
  /** Padded canvas height in pixels. */
  paddedHeight: number
  /** Top-left of the original content within the padded canvas. */
  contentX: number
  contentY: number
  /** Original (unpadded) content size — equals the plan prototype size. */
  contentWidth: number
  contentHeight: number
}

/** OpenRouter `image_config.image_size` / resolution tier. */
export type ImageSizeTier = '0.5K' | '1K' | '2K' | '4K'

/** Gemini 3.1 Flash Image — includes ultra-wide / ultra-tall extended ratios. */
export const GEMINI_FLASH_ASPECT_RATIOS: readonly string[] = [
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4',
  '8:1', '9:16', '16:9', '21:9',
]

/** Gemini 3 Pro Image — no 4:1 / 8:1. */
export const GEMINI_PRO_ASPECT_RATIOS: readonly string[] = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]

/** OpenAI GPT image models on OpenRouter. */
export const GPT_IMAGE_ASPECT_RATIOS: readonly string[] = [
  '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9',
]

/** Conservative default when the model family is unknown. */
export const DEFAULT_ASPECT_RATIOS: readonly string[] = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9',
]

/**
 * Parse an `"W:H"` aspect string into a width/height ratio.
 *
 * @throws If the string is not two positive finite numbers.
 */
export function parseAspectRatio(aspectRatio: string): number {
  const parts = aspectRatio.split(':')
  if (parts.length !== 2) {
    throw new Error(`Invalid aspect ratio "${aspectRatio}"`)
  }
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Invalid aspect ratio "${aspectRatio}"`)
  }
  return w / h
}

/**
 * Aspect ratios supported by a given OpenRouter model slug.
 */
export function aspectRatiosForModel(modelId: string): readonly string[] {
  const id = modelId.toLowerCase()
  if (id.includes('gemini-3.1-flash') || id.includes('gemini-3.1-flash-lite')) {
    return GEMINI_FLASH_ASPECT_RATIOS
  }
  if (id.includes('gemini')) {
    return GEMINI_PRO_ASPECT_RATIOS
  }
  if (id.includes('gpt-image') || (id.includes('gpt-5') && id.includes('image'))) {
    return GPT_IMAGE_ASPECT_RATIOS
  }
  return DEFAULT_ASPECT_RATIOS
}

/**
 * Pick the supported aspect ratio whose numeric value is closest to `width/height`.
 */
export function chooseNearestAspectRatio(
  width: number,
  height: number,
  ratios: readonly string[],
): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('chooseNearestAspectRatio requires positive finite dimensions')
  }
  if (ratios.length === 0) {
    throw new Error('chooseNearestAspectRatio requires at least one ratio')
  }

  const target = width / height
  let best = ratios[0]
  let bestErr = Number.POSITIVE_INFINITY
  for (const ratio of ratios) {
    const value = parseAspectRatio(ratio)
    const err = Math.abs(value - target)
    if (err < bestErr) {
      bestErr = err
      best = ratio
    }
  }
  return best
}

/**
 * Compute a centered letterbox/pillarbox layout that embeds `width×height`
 * into the nearest canvas matching `aspectRatio` (integer pixel sizes).
 */
export function computeAspectPadLayout(
  width: number,
  height: number,
  aspectRatio: string,
): AspectPadLayout {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const target = parseAspectRatio(aspectRatio)
  const current = w / h

  let paddedWidth: number
  let paddedHeight: number
  if (current < target) {
    // Content is relatively taller/narrower — pad width (pillarbox).
    paddedHeight = h
    paddedWidth = Math.max(w, Math.round(h * target))
  } else if (current > target) {
    // Content is relatively wider — pad height (letterbox).
    paddedWidth = w
    paddedHeight = Math.max(h, Math.round(w / target))
  } else {
    paddedWidth = w
    paddedHeight = h
  }

  const contentX = Math.floor((paddedWidth - w) / 2)
  const contentY = Math.floor((paddedHeight - h) / 2)

  return {
    aspectRatio,
    paddedWidth,
    paddedHeight,
    contentX,
    contentY,
    contentWidth: w,
    contentHeight: h,
  }
}

/**
 * Choose an OpenRouter resolution tier from the padded canvas's longest edge.
 *
 * @param supportsHalfK - When true (Gemini 3.1 Flash), allow `0.5K` for small maps.
 */
export function chooseImageSizeTier(
  paddedWidth: number,
  paddedHeight: number,
  supportsHalfK = false,
): ImageSizeTier {
  const longest = Math.max(paddedWidth, paddedHeight)
  if (supportsHalfK && longest <= 768) {
    return '0.5K'
  }
  if (longest <= 1280) {
    return '1K'
  }
  if (longest <= 2560) {
    return '2K'
  }
  return '4K'
}

/**
 * Full plan-bucket plan: nearest aspect for the model + pad layout + size tier.
 */
export function planImageBucket(
  width: number,
  height: number,
  modelId: string,
): AspectPadLayout & { imageSize: ImageSizeTier } {
  const ratios = aspectRatiosForModel(modelId)
  const aspectRatio = chooseNearestAspectRatio(width, height, ratios)
  const layout = computeAspectPadLayout(width, height, aspectRatio)
  const supportsHalfK =
    modelId.toLowerCase().includes('gemini-3.1-flash')
  const imageSize = chooseImageSizeTier(
    layout.paddedWidth,
    layout.paddedHeight,
    supportsHalfK,
  )
  return { ...layout, imageSize }
}
