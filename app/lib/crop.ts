import { GRID_CELL_PX } from '@/app/lib/referenceGrid'

/** Axis-aligned crop in image-pixel space. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export type AspectPreset =
  | 'free'
  | 'original'
  | 'custom'
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:2'
  | '2:3'
  /** Intended book size (same numeric ratio as 3:2). */
  | '54:36'

export const ASPECT_PRESETS: { value: AspectPreset; label: string; title?: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'original', label: 'Original' },
  { value: 'custom', label: 'Custom' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '54:36', label: '54×36', title: 'Intended book size' },
]

/**
 * Parse a custom aspect string into width/height.
 * Accepts `16:9`, `16/9`, `16x9`, `1.85:1`, or a single positive number.
 */
export function parseAspectRatio(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  const parts = trimmed.split(/[:/\u00d7xX]/)
  if (parts.length === 2) {
    const a = Number(parts[0].trim())
    const b = Number(parts[1].trim())
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      return a / b
    }
    return null
  }
  if (parts.length !== 1) {
    return null
  }
  const n = Number(parts[0].trim())
  if (Number.isFinite(n) && n > 0) {
    return n
  }
  return null
}

/**
 * Build the parse string for the custom width/height fields.
 * A lone width is treated as a decimal ratio (e.g. `1.85`) — only for
 * blur/commit; live typing should use {@link parseCustomAspectPair}.
 */
export function customAspectInput(width: string, height: string): string {
  const w = width.trim()
  const h = height.trim()
  if (w && h) {
    return `${w}:${h}`
  }
  return w
}

/**
 * Live-typing parse: only returns a ratio when BOTH custom fields are
 * non-empty positive numbers. A single field mid-edit (e.g. typing `1000`)
 * must not reshape the crop.
 */
export function parseCustomAspectPair(width: string, height: string): number | null {
  const w = width.trim()
  const h = height.trim()
  if (!w || !h) {
    return null
  }
  return parseAspectRatio(`${w}:${h}`)
}

/** Greatest common divisor for reducing integer aspect pairs. */
function gcdInt(a: number, b: number): number {
  let x = Math.round(Math.abs(a))
  let y = Math.round(Math.abs(b))
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x > 0 ? x : 1
}

/**
 * Reduce a pixel size to a small integer pair for the custom fields.
 */
export function simplifiedAspectParts(
  width: number,
  height: number,
): { w: string; h: string } {
  const iw = Math.max(1, Math.round(width))
  const ih = Math.max(1, Math.round(height))
  const d = gcdInt(iw, ih)
  return { w: String(iw / d), h: String(ih / d) }
}

/**
 * Width/height ratio for a preset, or null when the crop is unconstrained.
 * `customAspect` is used only when `preset` is `custom`.
 */
export function aspectRatioForPreset(
  preset: AspectPreset,
  imageWidth: number,
  imageHeight: number,
  customAspect = '',
): number | null {
  if (preset === 'free') {
    return null
  }
  if (preset === 'custom') {
    return parseAspectRatio(customAspect)
  }
  if (preset === 'original') {
    if (imageWidth <= 0 || imageHeight <= 0) {
      return null
    }
    return imageWidth / imageHeight
  }
  const parts = preset.split(':')
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return null
  }
  return a / b
}

/**
 * Integer crop that stays inside the image and is at least 1×1.
 */
export function clampCropRect(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  const maxW = Math.max(1, Math.floor(imageWidth))
  const maxH = Math.max(1, Math.floor(imageHeight))
  let w = Math.max(1, Math.round(rect.w))
  let h = Math.max(1, Math.round(rect.h))
  w = Math.min(w, maxW)
  h = Math.min(h, maxH)
  let x = Math.round(rect.x)
  let y = Math.round(rect.y)
  x = Math.min(Math.max(0, x), maxW - w)
  y = Math.min(Math.max(0, y), maxH - h)
  return { x, y, w, h }
}

/**
 * True when the rect already covers the whole image.
 */
export function isFullImageCrop(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number,
): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === imageWidth && rect.h === imageHeight
}

/**
 * Reshape a rect to `ratio` (width/height) while preserving its area and
 * center, then clamp into the image. One axis expands and the other
 * contracts so the change stays continuous with the existing selection.
 * If the area-preserving size cannot fit in the image, scale down to the
 * largest aspect-correct box that does (still centered).
 */
export function applyAspectToCrop(
  rect: CropRect,
  ratio: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (ratio <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return clampCropRect(rect, imageWidth, imageHeight)
  }
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const area = Math.max(1, rect.w) * Math.max(1, rect.h)
  let w = Math.sqrt(area * ratio)
  let h = Math.sqrt(area / ratio)
  // Largest aspect-correct box that fits in the image.
  const maxW = Math.min(imageWidth, imageHeight * ratio)
  if (w > maxW) {
    w = maxW
    h = w / ratio
  }
  return clampCropRect(
    { x: cx - w / 2, y: cy - h / 2, w, h },
    imageWidth,
    imageHeight,
  )
}

/**
 * Fit a drag (origin → current) to `ratio`, keeping `origin` as the
 * anchored corner, then clamp.
 */
export function applyAspectFromCorner(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  ratio: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (ratio <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    const x = Math.min(origin.x, current.x)
    const y = Math.min(origin.y, current.y)
    return clampCropRect(
      { x, y, w: Math.abs(current.x - origin.x), h: Math.abs(current.y - origin.y) },
      imageWidth,
      imageHeight,
    )
  }
  let w = Math.abs(current.x - origin.x)
  let h = Math.abs(current.y - origin.y)
  if (w < 1) {
    w = 1
  }
  if (h < 1) {
    h = 1
  }
  if (w / h > ratio) {
    h = w / ratio
  } else {
    w = h * ratio
  }
  const x = current.x >= origin.x ? origin.x : origin.x - w
  const y = current.y >= origin.y ? origin.y : origin.y - h
  return clampCropRect({ x, y, w, h }, imageWidth, imageHeight)
}

/**
 * Snap a coordinate to the nearest 1000px grid line, clamped to `[min, max]`.
 */
export function snapToGrid(value: number, min: number, max: number): number {
  if (max < min) {
    return min
  }
  const snapped = Math.round(value / GRID_CELL_PX) * GRID_CELL_PX
  return Math.min(max, Math.max(min, snapped))
}

/**
 * Snap all four edges to the 1000px grid, then clamp. Degenerate snaps
 * fall back to a 1px-safe clamp so the crop never collapses.
 */
export function snapCropToGrid(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  const x2 = snapToGrid(rect.x + rect.w, 1, imageWidth)
  const y2 = snapToGrid(rect.y + rect.h, 1, imageHeight)
  const x = snapToGrid(rect.x, 0, x2 - 1)
  const y = snapToGrid(rect.y, 0, y2 - 1)
  return clampCropRect({ x, y, w: x2 - x, h: y2 - y }, imageWidth, imageHeight)
}

/**
 * Load an image from a data URL or blob URL.
 */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve(img)
    }
    img.onerror = () => {
      reject(new Error('Failed to load image for crop'))
    }
    img.src = src
  })
}

/**
 * Rasterize `rect` out of `imageDataUrl` as a PNG. Same pixel size as the
 * clamped rect — does not change the source.
 */
export async function cropImageToRect(
  imageDataUrl: string,
  rect: CropRect,
): Promise<string> {
  const img = await loadImageElement(imageDataUrl)
  const width = img.naturalWidth
  const height = img.naturalHeight
  const safe = clampCropRect(rect, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = safe.w
  canvas.height = safe.h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to get canvas context for crop')
  }
  ctx.drawImage(img, safe.x, safe.y, safe.w, safe.h, 0, 0, safe.w, safe.h)
  return canvas.toDataURL('image/png')
}
