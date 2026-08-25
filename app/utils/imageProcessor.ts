import type { InpaintTileSpec, InpaintTilePlan } from '@/app/lib/app'
import type { AspectPadLayout } from '@/app/lib/imageBuckets'
import { planImageBucket } from '@/app/lib/imageBuckets'

export async function expandCanvas(
  originalImageDataUrl: string,
  direction: 'up' | 'down' | 'left' | 'right',
  extensionPercent: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = () => {
      const originalWidth = img.width
      const originalHeight = img.height
      
      // Calculate new dimensions
      let newWidth = originalWidth
      let newHeight = originalHeight
      let offsetX = 0
      let offsetY = 0
      
      const extensionAmount = extensionPercent / 100
      
      switch (direction) {
        case 'right':
          newWidth = Math.round(originalWidth * (1 + extensionAmount))
          offsetX = 0
          offsetY = 0
          break
        case 'left':
          newWidth = Math.round(originalWidth * (1 + extensionAmount))
          offsetX = newWidth - originalWidth
          offsetY = 0
          break
        case 'down':
          newHeight = Math.round(originalHeight * (1 + extensionAmount))
          offsetX = 0
          offsetY = 0
          break
        case 'up':
          newHeight = Math.round(originalHeight * (1 + extensionAmount))
          offsetX = 0
          offsetY = newHeight - originalHeight
          break
      }
      
      // Create canvas
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      const ctx = canvas.getContext('2d')
      
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      
      // Fill with white background (AI will fill this)
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(0, 0, newWidth, newHeight)
      
      // Draw original image at offset position
      ctx.drawImage(img, offsetX, offsetY, originalWidth, originalHeight)
      
      // Convert to data URL
      resolve(canvas.toDataURL('image/png'))
    }
    
    img.onerror = () => {
      reject(new Error('Failed to load image'))
    }
    
    img.src = originalImageDataUrl
  })
}

// New approach - send full image for context, but mark the area to extend
export async function createFullContextExtension(
  originalImageDataUrl: string,
  direction: 'up' | 'down' | 'left' | 'right',
  extensionPercent: number,
  referenceOriginalDimensions?: { width: number; height: number },
  maxDimension: number = 1536
): Promise<{ fullImageWithBlankArea: string; extensionInfo: ExtensionInfo }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = () => {
      const currentWidth = img.width
      const currentHeight = img.height
      
      const refWidth = referenceOriginalDimensions?.width || currentWidth
      const refHeight = referenceOriginalDimensions?.height || currentHeight
      
      const extensionAmount = extensionPercent / 100
      const extensionHeight = Math.round(refHeight * extensionAmount)
      const extensionWidth = Math.round(refWidth * extensionAmount)
      
      let newWidth = currentWidth
      let newHeight = currentHeight
      let originalOffsetX = 0
      let originalOffsetY = 0
      let extensionRegion: { x: number; y: number; width: number; height: number }
      
      switch (direction) {
        case 'up':
          newHeight = currentHeight + extensionHeight
          originalOffsetY = extensionHeight
          extensionRegion = { x: 0, y: 0, width: currentWidth, height: extensionHeight }
          break
        case 'down':
          newHeight = currentHeight + extensionHeight
          originalOffsetY = 0
          extensionRegion = { x: 0, y: currentHeight, width: currentWidth, height: extensionHeight }
          break
        case 'left':
          newWidth = currentWidth + extensionWidth
          originalOffsetX = extensionWidth
          extensionRegion = { x: 0, y: 0, width: extensionWidth, height: currentHeight }
          break
        case 'right':
          newWidth = currentWidth + extensionWidth
          originalOffsetX = 0
          extensionRegion = { x: currentWidth, y: 0, width: extensionWidth, height: currentHeight }
          break
      }
      
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      const ctx = canvas.getContext('2d')
      
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(0, 0, newWidth, newHeight)
      ctx.drawImage(img, originalOffsetX, originalOffsetY, currentWidth, currentHeight)
      
      const extensionInfo: ExtensionInfo = {
        direction,
        originalWidth: currentWidth,
        originalHeight: currentHeight,
        newWidth,
        newHeight,
        extensionRegion,
        originalPosition: { x: originalOffsetX, y: originalOffsetY }
      }
      
      const fullImageDataUrl = canvas.toDataURL('image/png')
      smartDownscale(fullImageDataUrl, direction, maxDimension).then(({ dataUrl, scale }) => {
        resolve({
          fullImageWithBlankArea: dataUrl,
          extensionInfo: { ...extensionInfo, scale }
        })
      }).catch(() => {
        resolve({
          fullImageWithBlankArea: fullImageDataUrl,
          extensionInfo: { ...extensionInfo, scale: 1 }
        })
      })
    }
    
    img.onerror = () => {
      reject(new Error('Failed to load image'))
    }
    
    img.src = originalImageDataUrl
  })
}

const EXTENSION_BLANK_COLOR = '#B0B0B0' // Gray blank area — distinguishable from white snow/sky in photos

export type ImageAlign = {
  x?: 'left' | 'center' | 'right'
  y?: 'top' | 'center' | 'bottom'
}

function getAlignOffset(target: number, scaled: number, align: 'left' | 'center' | 'right' | 'top' | 'bottom'): number {
  if (align === 'left' || align === 'top') return 0
  if (align === 'right' || align === 'bottom') return target - scaled
  return (target - scaled) / 2
}

/** Chunk alignment: anchor the edge that connects to the original image. */
export function getChunkAlign(direction: 'up' | 'down' | 'left' | 'right'): ImageAlign {
  switch (direction) {
    case 'right': return { x: 'left', y: 'center' }   // context on left of chunk
    case 'left': return { x: 'right', y: 'center' }   // context on right of chunk
    case 'down': return { x: 'center', y: 'top' }
    case 'up': return { x: 'center', y: 'bottom' }
  }
}

/** Full-canvas alignment: anchor the side where the original image sits. */
export function getCanvasAlign(direction: 'up' | 'down' | 'left' | 'right'): ImageAlign {
  switch (direction) {
    case 'right': return { x: 'left', y: 'center' }
    case 'left': return { x: 'right', y: 'center' }
    case 'down': return { x: 'center', y: 'top' }
    case 'up': return { x: 'center', y: 'bottom' }
  }
}

/**
 * Scale an image down so its longest side is at most `maxDim` pixels,
 * preserving aspect ratio. Returns a JPEG data URL (quality 0.85) so the
 * payload stays small when used as a scene-overview reference attachment.
 * If the image is already within the limit it is returned as-is (PNG).
 */
export function scaleImageToFit(imageDataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const { width, height } = img
      if (width <= maxDim && height <= maxDim) {
        resolve(imageDataUrl)
        return
      }
      const scale = Math.min(maxDim / width, maxDim / height)
      const targetWidth = Math.round(width * scale)
      const targetHeight = Math.round(height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(imageDataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => reject(new Error('Failed to load image for scaling'))
    img.src = imageDataUrl
  })
}

/** Fraction of the source image kept for the extension-adjacent edge overview. */
const SCENE_OVERVIEW_EDGE_FRACTION = 0.35

/**
 * Build a small reference thumbnail from the extension-adjacent edge of the
 * source image. Unlike a full-scene overview, this strip shows only what sits
 * at the boundary being extended — enough for palette/mood context without
 * giving the model a complete scene to copy wholesale into the tile output.
 */
export function buildSceneOverviewForExtension(
  imageDataUrl: string,
  direction: 'up' | 'down' | 'left' | 'right',
  maxDim: number = 384,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const { width, height } = img
      let sx = 0
      let sy = 0
      let sw = width
      let sh = height

      switch (direction) {
        case 'right':
          sw = Math.max(1, Math.round(width * SCENE_OVERVIEW_EDGE_FRACTION))
          sx = width - sw
          break
        case 'left':
          sw = Math.max(1, Math.round(width * SCENE_OVERVIEW_EDGE_FRACTION))
          break
        case 'down':
          sh = Math.max(1, Math.round(height * SCENE_OVERVIEW_EDGE_FRACTION))
          sy = height - sh
          break
        case 'up':
          sh = Math.max(1, Math.round(height * SCENE_OVERVIEW_EDGE_FRACTION))
          break
      }

      const scale = Math.min(1, maxDim / Math.max(sw, sh))
      const outW = Math.max(1, Math.round(sw * scale))
      const outH = Math.max(1, Math.round(sh * scale))

      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(imageDataUrl)
        return
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => reject(new Error('Failed to load image for scene overview'))
    img.src = imageDataUrl
  })
}

/** Resize image to exact dimensions with explicit alignment (cover + crop). */
export function normalizeImageToSize(
  imageDataUrl: string,
  targetWidth: number,
  targetHeight: number,
  align: ImageAlign = { x: 'center', y: 'center' }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      if (img.width === targetWidth && img.height === targetHeight) {
        resolve(imageDataUrl)
        return
      }

      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')

      if (!ctx) {
        resolve(imageDataUrl)
        return
      }

      const scale = Math.max(targetWidth / img.width, targetHeight / img.height)
      const scaledWidth = img.width * scale
      const scaledHeight = img.height * scale

      const offsetX = getAlignOffset(targetWidth, scaledWidth, align.x ?? 'center')
      const offsetY = getAlignOffset(targetHeight, scaledHeight, align.y ?? 'center')

      ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight)
      resolve(canvas.toDataURL('image/png'))
    }

    img.onerror = () => reject(new Error('Failed to load image for normalization'))
    img.src = imageDataUrl
  })
}

/**
 * Resize an AI image result to exact dimensions by stretching (no cover-crop,
 * no cross-axis centering).
 *
 * Used for high-res tile refine results and for plan-map results (global,
 * regional, and per-tile re-plan). Cover+center normalization silently shifts
 * content when the model returns a wrong aspect ratio — destroying neighbour
 * alignment at merge time and, for plans, mis-registering crop coordinates
 * so tile slices no longer abut the source edge. Exact stretch maps the
 * model's full frame onto the target rectangle so geometry stays corresponding
 * even if slightly distorted.
 *
 * @param imageDataUrl - Source image as a data URL.
 * @param targetWidth - Desired output width in pixels (rounded, min 1).
 * @param targetHeight - Desired output height in pixels (rounded, min 1).
 * @returns PNG data URL at exactly `targetWidth` × `targetHeight`.
 */
export function normalizeTileImageToSize(
  imageDataUrl: string,
  targetWidth: number,
  targetHeight: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Reject non-finite sizes early so we never create a zero-area canvas.
    if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight)) {
      reject(new Error('normalizeTileImageToSize requires finite target dimensions'))
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      const tw = Math.max(1, Math.round(targetWidth))
      const th = Math.max(1, Math.round(targetHeight))
      if (img.width === tw && img.height === th) {
        resolve(imageDataUrl)
        return
      }

      const canvas = document.createElement('canvas')
      canvas.width = tw
      canvas.height = th
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(imageDataUrl)
        return
      }

      // Stretch the full frame — never cover-crop — so every input pixel maps
      // into the output and plan/tile crop coords stay valid.
      ctx.drawImage(img, 0, 0, tw, th)
      resolve(canvas.toDataURL('image/png'))
    }

    img.onerror = () => reject(new Error('Failed to load image for stretch normalization'))
    img.src = imageDataUrl
  })
}

/**
 * Pad colour for aspect-bucket letterboxing. Must not be the planning grey
 * (#B0B0B0) so the model treats it as non-fill chrome; whatever happens in the
 * pad is discarded by {@link unpadImageFromAspectBucket} anyway.
 */
const PLAN_ASPECT_PAD_COLOR = '#2A2A2A'

/** Result of padding a plan prototype into a model aspect bucket. */
export interface PaddedPlanCanvas {
  /** Padded image data URL actually sent to the model. */
  paddedDataUrl: string
  /** Geometry of the original content inside the padded canvas. */
  layout: AspectPadLayout
  /** OpenRouter `image_config.image_size` tier for this padded size. */
  imageSize: '0.5K' | '1K' | '2K' | '4K'
}

/**
 * Embed a plan prototype into the nearest aspect-ratio bucket for `modelId`
 * (centered pad). Returns the padded canvas plus layout needed to unpad later.
 */
export async function padPlanCanvasToModelBucket(
  imageDataUrl: string,
  width: number,
  height: number,
  modelId: string,
): Promise<PaddedPlanCanvas> {
  const planned = planImageBucket(width, height, modelId)
  const {
    paddedWidth, paddedHeight, contentX, contentY, contentWidth, contentHeight,
    aspectRatio, imageSize,
  } = planned

  // Already on-bucket — no pad pixels needed.
  if (paddedWidth === contentWidth && paddedHeight === contentHeight) {
    return {
      paddedDataUrl: imageDataUrl,
      layout: {
        aspectRatio,
        paddedWidth,
        paddedHeight,
        contentX: 0,
        contentY: 0,
        contentWidth,
        contentHeight,
      },
      imageSize,
    }
  }

  const img = await loadImageElement(imageDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = paddedWidth
  canvas.height = paddedHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to get canvas context for plan aspect padding')
  }

  ctx.fillStyle = PLAN_ASPECT_PAD_COLOR
  ctx.fillRect(0, 0, paddedWidth, paddedHeight)
  ctx.drawImage(img, contentX, contentY, contentWidth, contentHeight)

  return {
    paddedDataUrl: canvas.toDataURL('image/jpeg', 0.92),
    layout: {
      aspectRatio,
      paddedWidth,
      paddedHeight,
      contentX,
      contentY,
      contentWidth,
      contentHeight,
    },
    imageSize,
  }
}

/**
 * Recover the original plan-prototype crop from a model response that was
 * generated against a padded aspect-bucket canvas.
 *
 * 1. Stretch-normalize the raw return to the padded size (same aspect).
 * 2. Crop out the content rect recorded at pad time.
 */
export async function unpadImageFromAspectBucket(
  responseDataUrl: string,
  layout: AspectPadLayout,
): Promise<string> {
  const {
    paddedWidth, paddedHeight, contentX, contentY, contentWidth, contentHeight,
  } = layout

  const normalized = await normalizeTileImageToSize(
    responseDataUrl,
    paddedWidth,
    paddedHeight,
  )

  // No pad was applied — normalized output is already the prototype size.
  if (
    contentX === 0 &&
    contentY === 0 &&
    contentWidth === paddedWidth &&
    contentHeight === paddedHeight
  ) {
    return normalized
  }

  const img = await loadImageElement(normalized)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, contentWidth)
  canvas.height = Math.max(1, contentHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to get canvas context for plan aspect unpad')
  }

  ctx.drawImage(
    img,
    contentX, contentY, contentWidth, contentHeight,
    0, 0, contentWidth, contentHeight,
  )
  return canvas.toDataURL('image/png')
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

/** Check if the horizontal extension strip is still unfilled after stitching. */
export async function isChunkExtensionUnfilled(
  imageDataUrl: string,
  chunkInfo: ChunkInfo
): Promise<boolean> {
  const img = await loadImageElement(imageDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  ctx.drawImage(img, 0, 0)
  const { direction, extensionSize, originalWidth } = chunkInfo

  let x = 0
  if (direction === 'right') x = originalWidth
  else if (direction === 'left') x = 0
  else return false

  const data = ctx.getImageData(x, 0, extensionSize, img.height).data
  let blankPixels = 0
  const totalPixels = extensionSize * img.height
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r > 200 && g > 200 && b > 200) blankPixels++
    else if (Math.abs(r - 176) < 30 && Math.abs(g - 176) < 30 && Math.abs(b - 176) < 30) blankPixels++
  }
  return blankPixels / totalPixels > 0.5
}

/** Check if the extension region is still mostly unfilled (gray/white). */
export async function isExtensionRegionUnfilled(
  imageDataUrl: string,
  extensionInfo: ExtensionInfo
): Promise<boolean> {
  const img = await loadImageElement(imageDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = extensionInfo.newWidth
  canvas.height = extensionInfo.newHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  ctx.drawImage(img, 0, 0, extensionInfo.newWidth, extensionInfo.newHeight)
  const { x, y, width, height } = extensionInfo.extensionRegion
  const data = ctx.getImageData(x, y, width, height).data

  let blankPixels = 0
  const totalPixels = width * height
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r > 200 && g > 200 && b > 200) blankPixels++
    else if (Math.abs(r - 176) < 30 && Math.abs(g - 176) < 30 && Math.abs(b - 176) < 30) blankPixels++
  }
  return blankPixels / totalPixels > 0.5
}

/**
 * Pre-correction: shift AI's bulk color in the extension area to match the
 * original's color at the seam. This handles the low-frequency color component
 * directly (the slowest-converging part of Gauss-Seidel) so Poisson only has
 * to clean up the high-frequency residual (gradients, fine detail), where it's
 * efficient. Massively reduces visible color seams across uniform regions
 * like sky, water, snow.
 *
 * Uniform shift preserves the AI's gradients (Laplacian of (S+c) = Laplacian
 * of S) so Poisson's gradient field is unchanged — only the starting color is
 * shifted to be near the right answer.
 */
function preCorrectAiColor(
  dstU8: Uint8ClampedArray,
  srcU8: Uint8ClampedArray,
  extensionInfo: ExtensionInfo,
  w: number,
  h: number
): { dR: number; dG: number; dB: number } {
  const { direction, originalWidth, originalHeight, originalPosition, extensionRegion } = extensionInfo
  const SAMPLE_DEPTH = 30
  const isHorizontal = direction === 'left' || direction === 'right'
  const isRight = direction === 'right'
  const isDown = direction === 'down'

  let oR = 0, oG = 0, oB = 0, oN = 0
  let aR = 0, aG = 0, aB = 0, aN = 0

  if (isHorizontal) {
    const seamX = isRight ? originalWidth + originalPosition.x : originalPosition.x
    for (let y = 0; y < h; y++) {
      for (let d = 1; d <= SAMPLE_DEPTH; d++) {
        const origX = isRight ? seamX - d : seamX + d - 1
        const aiX = isRight ? seamX + d - 1 : seamX - d
        if (origX >= 0 && origX < w) {
          const idx = (y * w + origX) * 4
          oR += dstU8[idx]; oG += dstU8[idx + 1]; oB += dstU8[idx + 2]; oN++
        }
        if (aiX >= 0 && aiX < w) {
          const idx = (y * w + aiX) * 4
          aR += srcU8[idx]; aG += srcU8[idx + 1]; aB += srcU8[idx + 2]; aN++
        }
      }
    }
  } else {
    const seamY = isDown ? originalHeight + originalPosition.y : originalPosition.y
    for (let x = 0; x < w; x++) {
      for (let d = 1; d <= SAMPLE_DEPTH; d++) {
        const origY = isDown ? seamY - d : seamY + d - 1
        const aiY = isDown ? seamY + d - 1 : seamY - d
        if (origY >= 0 && origY < h) {
          const idx = (origY * w + x) * 4
          oR += dstU8[idx]; oG += dstU8[idx + 1]; oB += dstU8[idx + 2]; oN++
        }
        if (aiY >= 0 && aiY < h) {
          const idx = (aiY * w + x) * 4
          aR += srcU8[idx]; aG += srcU8[idx + 1]; aB += srcU8[idx + 2]; aN++
        }
      }
    }
  }

  if (oN === 0 || aN === 0) return { dR: 0, dG: 0, dB: 0 }

  const dR = oR / oN - aR / aN
  const dG = oG / oN - aG / aN
  const dB = oB / oN - aB / aN

  // Apply uniform delta to AI pixels in the extension area in dstU8 (which
  // becomes Poisson's initial guess). srcU8 is left unchanged because uniform
  // shift doesn't affect the Laplacian.
  const { x: rx, y: ry, width: rw, height: rh } = extensionRegion
  for (let y = ry; y < ry + rh; y++) {
    const row = y * w
    for (let x = rx; x < rx + rw; x++) {
      const idx = (row + x) * 4
      const r = dstU8[idx] + dR
      const g = dstU8[idx + 1] + dG
      const b = dstU8[idx + 2] + dB
      dstU8[idx]     = r < 0 ? 0 : r > 255 ? 255 : r
      dstU8[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      dstU8[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b
    }
  }

  return { dR, dG, dB }
}

/**
 * Measure the residual seam quality after blending. Samples pixels just inside
 * vs just outside the seam and returns the mean absolute color difference per
 * channel. Lower = less visible seam (under ~6 is typically invisible at normal
 * viewing distance; over ~15 is clearly visible).
 *
 * Used by `applyFullContextResult` for the multi-attempt "best of N" selection
 * so we automatically pick the AI generation that blended best — addressing the
 * common pattern of needing to manually regenerate to get an acceptable result.
 */
export async function measureSeamResidual(
  blendedImageDataUrl: string,
  extensionInfo: ExtensionInfo,
  originalImageDataUrl: string
): Promise<number> {
  const [blendedImg, originalImg] = await Promise.all([
    loadImageElement(blendedImageDataUrl),
    loadImageElement(originalImageDataUrl),
  ])
  const { direction, originalWidth, originalHeight, newWidth, newHeight, originalPosition } = extensionInfo

  // Render original-at-correct-position reference and blended into the same canvas size.
  const refCanvas = document.createElement('canvas')
  refCanvas.width = newWidth
  refCanvas.height = newHeight
  const refCtx = refCanvas.getContext('2d')!
  refCtx.drawImage(
    originalImg,
    0, 0, originalWidth, originalHeight,
    originalPosition.x, originalPosition.y, originalWidth, originalHeight
  )
  const refData = refCtx.getImageData(0, 0, newWidth, newHeight).data

  const blendedCanvas = document.createElement('canvas')
  blendedCanvas.width = newWidth
  blendedCanvas.height = newHeight
  const blendedCtx = blendedCanvas.getContext('2d')!
  blendedCtx.drawImage(blendedImg, 0, 0, newWidth, newHeight)
  const blendedData = blendedCtx.getImageData(0, 0, newWidth, newHeight).data

  // Sample 4 pixels just inside the original side, 4 pixels just inside the
  // blended side of the seam. Measure mean abs delta between them.
  const SAMPLE_OFFSET = 4
  const isHorizontal = direction === 'left' || direction === 'right'
  const isRight = direction === 'right'
  const isDown = direction === 'down'

  let total = 0
  let count = 0

  if (isHorizontal) {
    const seamX = isRight ? originalWidth + originalPosition.x : originalPosition.x
    const origX = isRight ? seamX - SAMPLE_OFFSET : seamX + SAMPLE_OFFSET - 1
    const aiX = isRight ? seamX + SAMPLE_OFFSET - 1 : seamX - SAMPLE_OFFSET
    if (origX < 0 || origX >= newWidth || aiX < 0 || aiX >= newWidth) return 0
    for (let y = 0; y < newHeight; y++) {
      const origIdx = (y * newWidth + origX) * 4
      const aiIdx = (y * newWidth + aiX) * 4
      total += Math.abs(refData[origIdx] - blendedData[aiIdx])
      total += Math.abs(refData[origIdx + 1] - blendedData[aiIdx + 1])
      total += Math.abs(refData[origIdx + 2] - blendedData[aiIdx + 2])
      count += 3
    }
  } else {
    const seamY = isDown ? originalHeight + originalPosition.y : originalPosition.y
    const origY = isDown ? seamY - SAMPLE_OFFSET : seamY + SAMPLE_OFFSET - 1
    const aiY = isDown ? seamY + SAMPLE_OFFSET - 1 : seamY - SAMPLE_OFFSET
    if (origY < 0 || origY >= newHeight || aiY < 0 || aiY >= newHeight) return 0
    for (let x = 0; x < newWidth; x++) {
      const origIdx = (origY * newWidth + x) * 4
      const aiIdx = (aiY * newWidth + x) * 4
      total += Math.abs(refData[origIdx] - blendedData[aiIdx])
      total += Math.abs(refData[origIdx + 1] - blendedData[aiIdx + 1])
      total += Math.abs(refData[origIdx + 2] - blendedData[aiIdx + 2])
      count += 3
    }
  }

  return count > 0 ? total / count : 0
}

/**
 * Poisson image editing (Pérez et al. 2003) via Gauss-Seidel iterations.
 *
 * Solves ΔV = ΔS inside Ω with V = D on ∂Ω, which preserves the AI's
 * gradients (texture/detail) while forcing the seam pixels to match the
 * original's colors. Used in tandem with `preCorrectAiColor` which handles the
 * bulk color shift separately.
 *
 * Implementation notes:
 *   • Gauss-Seidel (red-black ordering) converges ~2× faster than plain Jacobi.
 *   • Mask is grown into the original by GROW_PX along the seam direction so
 *     the Dirichlet boundary sits inside the original, absorbing sub-pixel
 *     mismatches at the AI-original interface (the "grow then blur" trick
 *     from AUTOMATIC1111's outpainting_mk_2.py and ComfyUI's MaskGrow node).
 *   • Iterates the FULL mask including canvas-edge rows/cols (with replicate
 *     padding for out-of-bounds neighbors → Neumann boundary at canvas edges).
 *     Skipping these was making Poisson's boundary effectively "AI color" on
 *     3 of 4 sides for full-height/width extensions, causing color seams to
 *     persist deep into the strip.
 *   • All work is in Float32 typed arrays over the mask's bounding box.
 */
function poissonBlendOutpaint(
  originalImg: HTMLImageElement,
  aiImg: HTMLImageElement,
  extensionInfo: ExtensionInfo,
  iterations: number = 250
): HTMLCanvasElement {
  const { direction, newWidth, newHeight, originalWidth, originalHeight, originalPosition, extensionRegion } = extensionInfo

  // Build destination D = canvas with the original at its position, AI everywhere else.
  // (Outside the mask Ω, V stays = D, so the original is preserved exactly.)
  const dstCanvas = document.createElement('canvas')
  dstCanvas.width = newWidth
  dstCanvas.height = newHeight
  const dstCtx = dstCanvas.getContext('2d')!
  dstCtx.drawImage(aiImg, 0, 0, newWidth, newHeight)
  dstCtx.drawImage(
    originalImg,
    0, 0, originalWidth, originalHeight,
    originalPosition.x, originalPosition.y, originalWidth, originalHeight
  )
  const dstU8 = dstCtx.getImageData(0, 0, newWidth, newHeight).data

  // Source S = pure AI output (provides gradients inside Ω).
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = newWidth
  srcCanvas.height = newHeight
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.drawImage(aiImg, 0, 0, newWidth, newHeight)
  const srcU8 = srcCtx.getImageData(0, 0, newWidth, newHeight).data

  // Stage 1: pre-correct the bulk color shift so Poisson only has to fix the
  // high-frequency residual (which it converges to quickly).
  preCorrectAiColor(dstU8, srcU8, extensionInfo, newWidth, newHeight)

  const N = newWidth * newHeight
  const dstR = new Float32Array(N)
  const dstG = new Float32Array(N)
  const dstB = new Float32Array(N)
  const srcR = new Float32Array(N)
  const srcG = new Float32Array(N)
  const srcB = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const j = i * 4
    dstR[i] = dstU8[j];     dstG[i] = dstU8[j + 1];     dstB[i] = dstU8[j + 2]
    srcR[i] = srcU8[j];     srcG[i] = srcU8[j + 1];     srcB[i] = srcU8[j + 2]
  }

  // Grow the mask into the original by GROW_PX, but only in the seam direction.
  // This is the "grow then blur" trick: by moving Poisson's Dirichlet boundary
  // a few pixels INSIDE the original, any sub-pixel mismatch right at the
  // original-AI interface gets absorbed by the solver instead of showing as a seam.
  // The original detail in this ring is preserved because the AI faithfully
  // reproduced the original there (its gradients are nearly identical).
  const GROW_PX = Math.max(6, Math.min(14, Math.floor(Math.min(originalWidth, originalHeight) * 0.012)))
  let mx = extensionRegion.x
  let my = extensionRegion.y
  let mw = extensionRegion.width
  let mh = extensionRegion.height
  if (direction === 'right')      { mx -= GROW_PX; mw += GROW_PX }
  else if (direction === 'left')  { mw += GROW_PX }
  else if (direction === 'down')  { my -= GROW_PX; mh += GROW_PX }
  else if (direction === 'up')    { mh += GROW_PX }
  mx = Math.max(0, mx); my = Math.max(0, my)
  mw = Math.min(newWidth - mx, mw); mh = Math.min(newHeight - my, mh)

  const mask = new Uint8Array(N)
  for (let y = my; y < my + mh; y++) {
    const row = y * newWidth
    for (let x = mx; x < mx + mw; x++) mask[row + x] = 1
  }

  // Iterate over the FULL mask bounding box, including canvas-edge rows/cols.
  // Out-of-bounds neighbors are replicate-padded (clamped to image bounds),
  // giving canvas edges a Neumann (zero-gradient) boundary condition. This is
  // critical for full-height/width extensions where the mask touches the
  // canvas edge: skipping those rows leaves them frozen at the AI's initial
  // color, which then acts as a Dirichlet boundary pulling the interior toward
  // AI's color and defeating the seam at the original boundary.
  const x0 = mx
  const x1 = mx + mw
  const y0 = my
  const y1 = my + mh

  // Precompute Laplacian of S with replicate padding.
  const lapR = new Float32Array(N)
  const lapG = new Float32Array(N)
  const lapB = new Float32Array(N)
  for (let y = y0; y < y1; y++) {
    const row = y * newWidth
    const rowUp = (y > 0 ? y - 1 : 0) * newWidth
    const rowDn = (y < newHeight - 1 ? y + 1 : newHeight - 1) * newWidth
    for (let x = x0; x < x1; x++) {
      const i = row + x
      const xL = x > 0 ? x - 1 : 0
      const xR = x < newWidth - 1 ? x + 1 : newWidth - 1
      lapR[i] = 4 * srcR[i] - srcR[rowUp + x] - srcR[rowDn + x] - srcR[row + xL] - srcR[row + xR]
      lapG[i] = 4 * srcG[i] - srcG[rowUp + x] - srcG[rowDn + x] - srcG[row + xL] - srcG[row + xR]
      lapB[i] = 4 * srcB[i] - srcB[rowUp + x] - srcB[rowDn + x] - srcB[row + xL] - srcB[row + xR]
    }
  }

  // Initial guess V = D. Inside the extension proper, D = AI (color-corrected
  // by preCorrectAiColor above); inside the grown ring, D = original.
  const vR = new Float32Array(N)
  const vG = new Float32Array(N)
  const vB = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    vR[i] = dstR[i]; vG[i] = dstG[i]; vB[i] = dstB[i]
  }

  // Gauss-Seidel red-black ordering. On "red" pass we visit pixels where
  // (x + y) is even; on "black" pass, where it's odd. Each pass reads updated
  // values from the previous pass, doubling effective convergence speed vs Jacobi.
  for (let iter = 0; iter < iterations; iter++) {
    for (let parity = 0; parity < 2; parity++) {
      for (let y = y0; y < y1; y++) {
        const row = y * newWidth
        const rowUp = (y > 0 ? y - 1 : 0) * newWidth
        const rowDn = (y < newHeight - 1 ? y + 1 : newHeight - 1) * newWidth
        const startX = x0 + ((x0 + y + parity) & 1)
        for (let x = startX; x < x1; x += 2) {
          const i = row + x
          if (!mask[i]) continue
          const xL = x > 0 ? x - 1 : 0
          const xR = x < newWidth - 1 ? x + 1 : newWidth - 1
          const iU = rowUp + x, iD = rowDn + x, iL = row + xL, iR = row + xR
          const upR = mask[iU] ? vR[iU] : dstR[iU]
          const dnR = mask[iD] ? vR[iD] : dstR[iD]
          const lfR = mask[iL] ? vR[iL] : dstR[iL]
          const rtR = mask[iR] ? vR[iR] : dstR[iR]
          const upG = mask[iU] ? vG[iU] : dstG[iU]
          const dnG = mask[iD] ? vG[iD] : dstG[iD]
          const lfG = mask[iL] ? vG[iL] : dstG[iL]
          const rtG = mask[iR] ? vG[iR] : dstG[iR]
          const upB = mask[iU] ? vB[iU] : dstB[iU]
          const dnB = mask[iD] ? vB[iD] : dstB[iD]
          const lfB = mask[iL] ? vB[iL] : dstB[iL]
          const rtB = mask[iR] ? vB[iR] : dstB[iR]
          vR[i] = (upR + dnR + lfR + rtR + lapR[i]) * 0.25
          vG[i] = (upG + dnG + lfG + rtG + lapG[i]) * 0.25
          vB[i] = (upB + dnB + lfB + rtB + lapB[i]) * 0.25
        }
      }
    }
  }

  const out = new ImageData(newWidth, newHeight)
  const od = out.data
  for (let i = 0; i < N; i++) {
    const j = i * 4
    if (mask[i]) {
      od[j]     = vR[i] < 0 ? 0 : vR[i] > 255 ? 255 : vR[i]
      od[j + 1] = vG[i] < 0 ? 0 : vG[i] > 255 ? 255 : vG[i]
      od[j + 2] = vB[i] < 0 ? 0 : vB[i] > 255 ? 255 : vB[i]
    } else {
      od[j]     = dstR[i]
      od[j + 1] = dstG[i]
      od[j + 2] = dstB[i]
    }
    od[j + 3] = 255
  }

  const result = document.createElement('canvas')
  result.width = newWidth
  result.height = newHeight
  result.getContext('2d')!.putImageData(out, 0, 0)
  return result
}

/**
 * Apply full-context AI result with Poisson blending.
 * Gradient-domain blending preserves AI textures while mathematically forcing
 * the seam to match the original — the same technique professional outpainting
 * tools (Adobe, ComfyUI, the Nano Banana ComfyUI node) use.
 */
export async function applyFullContextResult(
  aiImageDataUrl: string,
  extensionInfo: ExtensionInfo,
  originalImageDataUrl: string
): Promise<string> {
  const normalizedAi = await normalizeImageToSize(
    aiImageDataUrl,
    extensionInfo.newWidth,
    extensionInfo.newHeight,
    getCanvasAlign(extensionInfo.direction)
  )

  const [aiImg, originalImg] = await Promise.all([
    loadImageElement(normalizedAi),
    loadImageElement(originalImageDataUrl),
  ])

  // Poisson blending: source = AI, destination = canvas with original placed,
  // mask = extension region. Inside the mask, V is solved so its Laplacian
  // matches the AI's gradients while V at the seam = original's pixels exactly.
  // This eliminates color seams and brightness mismatches without smearing detail.
  const blended = poissonBlendOutpaint(originalImg, aiImg, extensionInfo)
  return blended.toDataURL('image/png')
}

/** Validate AI output before compositing — checks the raw AI image extension region. */
export async function isAiExtensionUnfilled(
  aiImageDataUrl: string,
  extensionInfo: ExtensionInfo
): Promise<boolean> {
  const normalized = await normalizeImageToSize(
    aiImageDataUrl,
    extensionInfo.newWidth,
    extensionInfo.newHeight,
    getCanvasAlign(extensionInfo.direction)
  )
  return isExtensionRegionUnfilled(normalized, extensionInfo)
}

// Interface for full context extension info
export interface ExtensionInfo {
  direction: 'up' | 'down' | 'left' | 'right'
  originalWidth: number
  originalHeight: number
  newWidth: number
  newHeight: number
  extensionRegion: { x: number; y: number; width: number; height: number }
  originalPosition: { x: number; y: number }
  scale?: number
}

// Helper function to downscale image while preserving aspect ratio
async function smartDownscale(
  imageDataUrl: string, 
  direction: 'up' | 'down' | 'left' | 'right',
  maxDimension: number = 2048
): Promise<{ dataUrl: string; scale: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = () => {
      const width = img.width
      const height = img.height
      
      // Find the larger dimension
      const maxSize = Math.max(width, height)
      
      // If within limits, return as-is
      if (maxSize <= maxDimension) {
        resolve({ dataUrl: imageDataUrl, scale: 1 })
        return
      }
      
      // Scale PROPORTIONALLY to maintain aspect ratio
      // This is critical so AI sees the correct shape of what it needs to generate
      const scale = maxDimension / maxSize
      const newWidth = Math.round(width * scale)
      const newHeight = Math.round(height * scale)
      
      console.log(`📏 Proportional downscaling for ${direction.toUpperCase()}: ${width}x${height} → ${newWidth}x${newHeight} (scale: ${scale.toFixed(2)})`)
      
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      const ctx = canvas.getContext('2d')
      
      if (ctx) {
        // Use JPEG with good quality to reduce payload size while maintaining quality
        ctx.drawImage(img, 0, 0, newWidth, newHeight)
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.95), scale })
      } else {
        resolve({ dataUrl: imageDataUrl, scale: 1 })
      }
    }
    
    img.src = imageDataUrl
  })
}

// Old chunked extension approach - only takes a portion of the image to extend
export async function createChunkedExtension(
  originalImageDataUrl: string,
  direction: 'up' | 'down' | 'left' | 'right',
  extensionPercent: number,
  overlapPercent: number = 40, // Context area: how much existing image to send to AI (lower = less regeneration of good parts)
  referenceOriginalDimensions?: { width: number; height: number }, // Reference dimensions for consistent percentage calculations
  maxDimension: number = 1536 // Maximum dimension to send to AI (balanced for quality and API limits)
): Promise<{ chunkToExtend: string; chunkInfo: ChunkInfo }> {
  return new Promise(async (resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    img.onload = async () => {
      const currentWidth = img.width
      const currentHeight = img.height
      
      // Use reference dimensions if provided, otherwise use current image dimensions
      const refWidth = referenceOriginalDimensions?.width || currentWidth
      const refHeight = referenceOriginalDimensions?.height || currentHeight
      
      // Calculate chunk dimensions based on direction
      let chunkInfo: ChunkInfo
      let sourceX = 0, sourceY = 0, sourceWidth = 0, sourceHeight = 0
      let newWidth = 0, newHeight = 0
      let offsetX = 0, offsetY = 0
      
      const extensionAmount = extensionPercent / 100
      const overlapAmount = overlapPercent / 100
      
      switch (direction) {
        case 'up':
          // Take top portion of CURRENT image (context area)
          sourceWidth = currentWidth
          sourceHeight = Math.round(currentHeight * overlapAmount)
          sourceX = 0
          sourceY = 0
          
          // Calculate extension based on REFERENCE (original) image dimensions for consistency
          const extensionHeight = Math.round(refHeight * extensionAmount)
          
          // Add white space above the context area
          newWidth = sourceWidth
          newHeight = sourceHeight + extensionHeight
          offsetX = 0
          offsetY = extensionHeight
          
          chunkInfo = {
            direction,
            originalWidth: currentWidth,
            originalHeight: currentHeight,
            chunkWidth: sourceWidth,
            chunkHeight: sourceHeight,
            extensionSize: extensionHeight,
            sourceX,
            sourceY
          }
          break
          
        case 'down':
          // Take bottom portion of CURRENT image (context area)
          sourceWidth = currentWidth
          sourceHeight = Math.round(currentHeight * overlapAmount)
          sourceX = 0
          sourceY = currentHeight - sourceHeight
          
          // Calculate extension based on REFERENCE (original) image dimensions
          const extensionHeightDown = Math.round(refHeight * extensionAmount)
          
          // Add white space below the context area
          newWidth = sourceWidth
          newHeight = sourceHeight + extensionHeightDown
          offsetX = 0
          offsetY = 0
          
          chunkInfo = {
            direction,
            originalWidth: currentWidth,
            originalHeight: currentHeight,
            chunkWidth: sourceWidth,
            chunkHeight: sourceHeight,
            extensionSize: extensionHeightDown,
            sourceX,
            sourceY
          }
          break
          
        case 'left':
          // Take left portion of CURRENT image (context area)
          sourceWidth = Math.round(currentWidth * overlapAmount)
          sourceHeight = currentHeight
          sourceX = 0
          sourceY = 0
          
          // Calculate extension based on REFERENCE (original) image dimensions
          const extensionWidthLeft = Math.round(refWidth * extensionAmount)
          
          // Add white space to left of context area
          newWidth = sourceWidth + extensionWidthLeft
          newHeight = sourceHeight
          offsetX = extensionWidthLeft
          offsetY = 0
          
          chunkInfo = {
            direction,
            originalWidth: currentWidth,
            originalHeight: currentHeight,
            chunkWidth: sourceWidth,
            chunkHeight: sourceHeight,
            extensionSize: extensionWidthLeft,
            sourceX,
            sourceY
          }
          break
          
        case 'right':
          // Take right portion of CURRENT image (context area)
          sourceWidth = Math.round(currentWidth * overlapAmount)
          sourceHeight = currentHeight
          sourceX = currentWidth - sourceWidth
          sourceY = 0
          
          // Calculate extension based on REFERENCE (original) image dimensions
          const extensionWidthRight = Math.round(refWidth * extensionAmount)
          
          // Add white space to right of context area
          newWidth = sourceWidth + extensionWidthRight
          newHeight = sourceHeight
          offsetX = 0
          offsetY = 0
          
          chunkInfo = {
            direction,
            originalWidth: currentWidth,
            originalHeight: currentHeight,
            chunkWidth: sourceWidth,
            chunkHeight: sourceHeight,
            extensionSize: extensionWidthRight,
            sourceX,
            sourceY
          }
          break
      }
      
      // Create canvas for the chunk with extension
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = newHeight
      const ctx = canvas.getContext('2d')
      
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      
      // Fill with white background
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(0, 0, newWidth, newHeight)
      
      // Draw the chunk from original image
      ctx.drawImage(
        img,
        sourceX, sourceY, sourceWidth, sourceHeight, // Source
        offsetX, offsetY, sourceWidth, sourceHeight  // Destination
      )
      
      // Smart downscale before sending to AI to prevent aggressive compression
      // Only scale the dimension being extended (keep width constant for up/down)
      const chunkDataUrl = canvas.toDataURL('image/png')
      smartDownscale(chunkDataUrl, direction, maxDimension).then(({ dataUrl, scale }) => {
        resolve({
          chunkToExtend: dataUrl,
          chunkInfo: { ...chunkInfo, scale }
        })
      }).catch(() => {
        // Fallback to original if downscale fails
        resolve({
          chunkToExtend: chunkDataUrl,
          chunkInfo: { ...chunkInfo, scale: 1 }
        })
      })
    }
    
    img.onerror = () => {
      reject(new Error('Failed to load image'))
    }
    
    img.src = originalImageDataUrl
  })
}

// Stitch the extended chunk back to the original image
export async function stitchExtendedChunk(
  originalImageDataUrl: string,
  extendedChunkDataUrl: string,
  chunkInfo: ChunkInfo,
  debugMode: boolean = false // Add debug overlay to visualize seam
): Promise<string> {
  return new Promise((resolve, reject) => {
    const originalImg = new Image()
    const extendedImg = new Image()
    
    let originalLoaded = false
    let extendedLoaded = false
    
    const checkBothLoaded = () => {
      if (!originalLoaded || !extendedLoaded) return
      
      const { direction, originalWidth, originalHeight, chunkWidth, chunkHeight, extensionSize, scale = 1 } = chunkInfo
      
      // DEBUG: Log all dimensions
      console.log('=== STITCHING DEBUG INFO ===')
      console.log('Direction:', direction)
      console.log('Original Image:', originalImg.width, 'x', originalImg.height)
      console.log('Extended Chunk (AI result):', extendedImg.width, 'x', extendedImg.height)
      console.log('ChunkInfo - originalWidth:', originalWidth, 'originalHeight:', originalHeight)
      console.log('ChunkInfo - chunkWidth:', chunkWidth, 'chunkHeight:', chunkHeight)
      console.log('ChunkInfo - extensionSize:', extensionSize)
      
      // Check for dimension mismatches
      if (originalImg.width !== originalWidth || originalImg.height !== originalHeight) {
        console.warn('⚠️ DIMENSION MISMATCH DETECTED!')
        console.warn('Expected original:', originalWidth, 'x', originalHeight)
        console.warn('Actual original:', originalImg.width, 'x', originalImg.height)
      }
      
      // Calculate expected extended chunk dimensions (full resolution)
      const expectedChunkWidth = direction === 'left' || direction === 'right' 
        ? chunkWidth + extensionSize 
        : originalWidth
      const expectedChunkHeight = direction === 'up' || direction === 'down'
        ? chunkHeight + extensionSize
        : originalHeight

      // Dimensions at the scale sent to the AI (before upscaling back)
      const sentChunkWidth = Math.round(expectedChunkWidth * scale)
      const sentChunkHeight = Math.round(expectedChunkHeight * scale)
      
      console.log('Expected extended chunk:', expectedChunkWidth, 'x', expectedChunkHeight)
      console.log('Sent to AI (scaled):', sentChunkWidth, 'x', sentChunkHeight, `(scale: ${scale})`)
      
      // Handle AI dimension changes by resizing to expected dimensions
      let processedExtendedImg = extendedImg
      
      const resizeImage = (img: HTMLImageElement, width: number, height: number, onDone: (resized: HTMLImageElement) => void) => {
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = img.width
        tempCanvas.height = img.height
        tempCanvas.getContext('2d')?.drawImage(img, 0, 0)

        normalizeImageToSize(tempCanvas.toDataURL('image/png'), width, height, getChunkAlign(direction))
          .then((dataUrl) => {
            const resizedImg = new Image()
            resizedImg.onload = () => onDone(resizedImg)
            resizedImg.onerror = () => onDone(img)
            resizedImg.src = dataUrl
          })
          .catch(() => onDone(img))
      }
      
      if (extendedImg.width !== sentChunkWidth || extendedImg.height !== sentChunkHeight) {
        console.warn('⚠️ AI CHANGED DIMENSIONS (at sent scale)!')
        console.warn('Expected (sent scale):', sentChunkWidth, 'x', sentChunkHeight)
        console.warn('AI returned:', extendedImg.width, 'x', extendedImg.height)
        console.warn('🔧 Resizing to sent-scale dimensions...')
        
        resizeImage(extendedImg, sentChunkWidth, sentChunkHeight, (resizedAtSentScale) => {
          if (scale !== 1) {
            console.warn('🔧 Upscaling to full resolution...')
            resizeImage(resizedAtSentScale, expectedChunkWidth, expectedChunkHeight, (fullRes) => {
              console.log('✅ Resized to full res:', fullRes.width, 'x', fullRes.height)
              processedExtendedImg = fullRes
              continueStitching()
            })
          } else {
            console.log('✅ Resized to:', resizedAtSentScale.width, 'x', resizedAtSentScale.height)
            processedExtendedImg = resizedAtSentScale
            continueStitching()
          }
        })
        return
      }
      
      if (scale !== 1) {
        console.warn('🔧 Upscaling AI result from sent scale to full resolution...')
        resizeImage(extendedImg, expectedChunkWidth, expectedChunkHeight, (fullRes) => {
          console.log('✅ Upscaled to:', fullRes.width, 'x', fullRes.height)
          processedExtendedImg = fullRes
          continueStitching()
        })
        return
      }
      
      continueStitching()
      
      function continueStitching() {
      
        // Calculate final dimensions based on processed (potentially resized) extended image
        // Extended chunk = new content + AI-blended overlap
        // Remaining original = original minus the overlap portion
        let finalWidth = originalWidth
        let finalHeight = originalHeight
        
        switch (direction) {
          case 'up':
          case 'down':
            // Final height = extended chunk height + remaining original height
            finalHeight = processedExtendedImg.height + (originalHeight - chunkHeight)
            break
          case 'left':
          case 'right':
            // Final width = extended chunk width + remaining original width
            finalWidth = processedExtendedImg.width + (originalWidth - chunkWidth)
            break
        }
        
        console.log('Final canvas size:', finalWidth, 'x', finalHeight)
        console.log('===========================\n')
        
        // Create final canvas
        const canvas = document.createElement('canvas')
        canvas.width = finalWidth
        canvas.height = finalHeight
        const ctx = canvas.getContext('2d')
        
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }
        
        // Position images based on direction with gradient feathering for seamless blending
        // Use the overlap dimension along the extension axis (width for L/R, height for U/D)
        const overlapSize = direction === 'left' || direction === 'right'
          ? chunkInfo.chunkWidth
          : chunkInfo.chunkHeight
        const baseFeatherSize = Math.floor(overlapSize * 0.2) // 20% of overlap region
        const featherSize = Math.min(
          Math.max(30, baseFeatherSize),
          200,
          Math.floor(overlapSize * 0.25) // Never feather more than 25% of overlap
        )
        
        console.log('--- POSITIONING DEBUG ---')
        console.log('Feather size:', featherSize, 'px')
        
        switch (direction) {
          case 'up':
            // 1. Draw entire extended chunk at top
            console.log('Step 1: Drawing extended chunk at (0, 0) size:', processedExtendedImg.width, 'x', processedExtendedImg.height)
            ctx.drawImage(processedExtendedImg, 0, 0)
          
            // 2. Draw remaining original below
            const extendedChunkHeight = processedExtendedImg.height
            const overlapStartY = extendedChunkHeight
          
            const sourceStartY = chunkInfo.chunkHeight
            const sourceHeightUp = originalHeight - chunkInfo.chunkHeight
            const destStartY = extendedChunkHeight
            
            console.log('Step 2: Drawing remaining original')
            console.log('  Source: (0,', sourceStartY, ') size:', originalWidth, 'x', sourceHeightUp)
            console.log('  Dest: (0,', destStartY, ') size:', finalWidth, 'x', sourceHeightUp)
            console.log('  Seam position (Y):', overlapStartY)
            
            ctx.drawImage(
              originalImg,
              0, sourceStartY, originalWidth, sourceHeightUp,
              0, destStartY, finalWidth, sourceHeightUp
            )
          
          // 3. Apply gradient feathering at the seam for seamless blending
          const gradientY = overlapStartY - featherSize
          console.log('Step 3: Applying gradient feather')
          console.log('  Gradient zone: Y', gradientY, 'to', overlapStartY + featherSize)
          console.log('  Feather zone height:', featherSize * 2, 'px')
          
          const gradient = ctx.createLinearGradient(0, gradientY, 0, overlapStartY + featherSize)
          gradient.addColorStop(0, 'rgba(0,0,0,1)')     // Extended chunk fully visible
          gradient.addColorStop(0.5, 'rgba(0,0,0,0.5)') // 50% blend at seam
          gradient.addColorStop(1, 'rgba(0,0,0,0)')     // Original fully visible
          
          // Create temporary canvas for gradient mask
          const tempCanvas = document.createElement('canvas')
          tempCanvas.width = finalWidth
          tempCanvas.height = featherSize * 2
          const tempCtx = tempCanvas.getContext('2d')
          
          if (tempCtx) {
            // Draw the transition area from both images
            tempCtx.drawImage(canvas, 0, gradientY, finalWidth, featherSize * 2, 0, 0, finalWidth, featherSize * 2)
            
            // Apply gradient mask
            tempCtx.globalCompositeOperation = 'destination-in'
            tempCtx.fillStyle = gradient
            tempCtx.fillRect(0, 0, finalWidth, featherSize * 2)
            
            // Draw back with blending
            ctx.globalCompositeOperation = 'source-over'
            ctx.drawImage(tempCanvas, 0, gradientY)
          }
          console.log('-------------------------\n')
          
          // DEBUG: Draw visual markers at seam
          if (debugMode) {
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)'
            ctx.lineWidth = 2
            ctx.setLineDash([10, 5])
            ctx.beginPath()
            ctx.moveTo(0, overlapStartY)
            ctx.lineTo(finalWidth, overlapStartY)
            ctx.stroke()
            ctx.setLineDash([])
            
            // Add text label
            ctx.fillStyle = 'rgba(255, 0, 0, 0.9)'
            ctx.font = 'bold 16px Arial'
            ctx.fillText(`Seam at Y: ${overlapStartY}`, 10, overlapStartY - 10)
          }
          break
          
          case 'down':
            // 1. Draw non-overlapping portion of original at top
            const nonOverlapHeight = originalHeight - chunkInfo.chunkHeight
            ctx.drawImage(
              originalImg,
              0, 0, originalWidth, nonOverlapHeight,
              0, 0, finalWidth, nonOverlapHeight
            )
            
            // 2. Draw entire extended chunk below
            ctx.drawImage(processedExtendedImg, 0, nonOverlapHeight)
          
          // 3. Apply gradient feathering at the seam
          const overlapStartYDown = nonOverlapHeight
          const gradientYDown = overlapStartYDown - featherSize
          const gradientDown = ctx.createLinearGradient(0, gradientYDown, 0, overlapStartYDown + featherSize)
          gradientDown.addColorStop(0, 'rgba(0,0,0,0)')
          gradientDown.addColorStop(0.5, 'rgba(0,0,0,0.5)')
          gradientDown.addColorStop(1, 'rgba(0,0,0,1)')
          
          const tempCanvasDown = document.createElement('canvas')
          tempCanvasDown.width = finalWidth
          tempCanvasDown.height = featherSize * 2
          const tempCtxDown = tempCanvasDown.getContext('2d')
          
          if (tempCtxDown) {
            tempCtxDown.drawImage(canvas, 0, gradientYDown, finalWidth, featherSize * 2, 0, 0, finalWidth, featherSize * 2)
            tempCtxDown.globalCompositeOperation = 'destination-in'
            tempCtxDown.fillStyle = gradientDown
            tempCtxDown.fillRect(0, 0, finalWidth, featherSize * 2)
            ctx.globalCompositeOperation = 'source-over'
            ctx.drawImage(tempCanvasDown, 0, gradientYDown)
          }
          break
          
          case 'left':
            // Layout: [AI chunk (extension + overlap) | original non-overlap]
            ctx.drawImage(
              originalImg,
              0, 0, originalWidth, originalHeight,
              extensionSize, 0, originalWidth, finalHeight
            )
            ctx.drawImage(
              processedExtendedImg,
              0, 0, processedExtendedImg.width, processedExtendedImg.height,
              0, 0, processedExtendedImg.width, finalHeight
            )
          
          const overlapStartXLeft = extensionSize
          const gradientXLeft = overlapStartXLeft - featherSize
          const gradientLeft = ctx.createLinearGradient(gradientXLeft, 0, overlapStartXLeft + featherSize, 0)
          gradientLeft.addColorStop(0, 'rgba(0,0,0,1)')
          gradientLeft.addColorStop(0.5, 'rgba(0,0,0,0.5)')
          gradientLeft.addColorStop(1, 'rgba(0,0,0,0)')
          
          const tempCanvasLeft = document.createElement('canvas')
          tempCanvasLeft.width = featherSize * 2
          tempCanvasLeft.height = finalHeight
          const tempCtxLeft = tempCanvasLeft.getContext('2d')
          
          if (tempCtxLeft) {
            tempCtxLeft.drawImage(canvas, gradientXLeft, 0, featherSize * 2, finalHeight, 0, 0, featherSize * 2, finalHeight)
            tempCtxLeft.globalCompositeOperation = 'destination-in'
            tempCtxLeft.fillStyle = gradientLeft
            tempCtxLeft.fillRect(0, 0, featherSize * 2, finalHeight)
            ctx.globalCompositeOperation = 'source-over'
            ctx.drawImage(tempCanvasLeft, gradientXLeft, 0)
          }
          break
          
          case 'right': {
            const overlapStartX = originalWidth - chunkWidth
            ctx.drawImage(
              originalImg,
              0, 0, overlapStartX, originalHeight,
              0, 0, overlapStartX, finalHeight
            )
            ctx.drawImage(
              processedExtendedImg,
              0, 0, processedExtendedImg.width, processedExtendedImg.height,
              overlapStartX, 0, processedExtendedImg.width, finalHeight
            )
          
          const overlapStartXRight = overlapStartX
          const gradientXRight = overlapStartXRight - featherSize
          const gradientRight = ctx.createLinearGradient(gradientXRight, 0, overlapStartXRight + featherSize, 0)
          gradientRight.addColorStop(0, 'rgba(0,0,0,0)')
          gradientRight.addColorStop(0.5, 'rgba(0,0,0,0.5)')
          gradientRight.addColorStop(1, 'rgba(0,0,0,1)')
          
          const tempCanvasRight = document.createElement('canvas')
          tempCanvasRight.width = featherSize * 2
          tempCanvasRight.height = finalHeight
          const tempCtxRight = tempCanvasRight.getContext('2d')
          
          if (tempCtxRight) {
            tempCtxRight.drawImage(canvas, gradientXRight, 0, featherSize * 2, finalHeight, 0, 0, featherSize * 2, finalHeight)
            tempCtxRight.globalCompositeOperation = 'destination-in'
            tempCtxRight.fillStyle = gradientRight
            tempCtxRight.fillRect(0, 0, featherSize * 2, finalHeight)
            ctx.globalCompositeOperation = 'source-over'
            ctx.drawImage(tempCanvasRight, gradientXRight, 0)
          }
            break
          }
        }
        
        resolve(canvas.toDataURL('image/png'))
      } // End of continueStitching()
    }
    
    originalImg.onload = () => {
      originalLoaded = true
      checkBothLoaded()
    }
    
    extendedImg.onload = () => {
      extendedLoaded = true
      checkBothLoaded()
    }
    
    originalImg.onerror = () => reject(new Error('Failed to load original image'))
    extendedImg.onerror = () => reject(new Error('Failed to load extended chunk'))
    
    originalImg.src = originalImageDataUrl
    extendedImg.src = extendedChunkDataUrl
  })
}

export interface ChunkInfo {
  direction: 'up' | 'down' | 'left' | 'right'
  originalWidth: number
  originalHeight: number
  chunkWidth: number
  chunkHeight: number
  extensionSize: number
  sourceX: number
  sourceY: number
  scale?: number
  /** When this chunk is one tile of a tiled extension, its 0-based index. */
  tileIndex?: number
  /** Total tile count when this is part of a tiled extension. */
  tileCount?: number
}

export function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.width, height: img.height })
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiled full-resolution extension
//
// When a band (context strip + blank extension area) would exceed MAX_AI_DIMENSION
// in either axis, these helpers split it into an overlapping grid of tiles that
// each fit within the limit.  Tiles are generated sequentially in
// context→extension scan order so every tile sees already-painted neighbor
// pixels as real content — the primary seam-coherence mechanism.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-edge feather widths (px) when compositing a tile into the running band. */
export interface TileFeatherOverlap {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * One tile in the extension grid.  Carries its position in the band canvas,
 * its pixel dimensions, the sub-rect that was originally gray (the part the
 * AI must fill), and which edges face already-processed neighbors (used to
 * build the 2D separable feather mask at composite time).
 */
export interface ExtensionTileSpec {
  row: number
  col: number
  totalRows: number
  totalCols: number
  /** Top-left of this tile in band-canvas coordinates. */
  bandX: number
  bandY: number
  /** Actual pixel size of this tile (±1 px when the band does not divide evenly). */
  tileWidth: number
  tileHeight: number
  /**
   * Sub-rect within the tile (tile-local coords) that was EXTENSION_BLANK_COLOR
   * in the initial band canvas.  Zero-area means the tile is pure context —
   * skip the API call, the band is already correct from initBandCanvas().
   */
  blankRegion: { x: number; y: number; width: number; height: number }
  /**
   * For each edge: overlap px with an already-processed neighbor.
   * 0 = no feathering on that edge.  Drives the 2D separable feather mask.
   */
  featherOverlap: TileFeatherOverlap
}

/** Result of planExtensionTiles(). */
export interface TiledExtensionPlan {
  /** Tiles sorted in the order they must be generated. */
  tiles: ExtensionTileSpec[]
  bandWidth: number
  bandHeight: number
  /**
   * Synthetic ChunkInfo describing the whole assembled band as a single chunk.
   * Pass unchanged to stitchExtendedChunk() after all tiles are composited.
   */
  bandChunkInfo: ChunkInfo
}

export interface PlanExtensionTilesParams {
  direction: 'up' | 'down' | 'left' | 'right'
  imageWidth: number
  imageHeight: number
  extensionPercent: number
  maxDimension: number
  tileOverlapPx: number
  maxTiles: number
}

/** Sizes and start positions for one axis of the extension-band tile grid. */
interface TilingAxisPlan {
  count: number
  sizes: number[]
  positions: number[]
}

/**
 * Split one band axis into overlapping tiles of nearly equal size.
 *
 * Picks the minimum tile count so each tile stays ≤ maxDimension, then
 * distributes length so `count` tiles with `(count − 1)` fixed overlaps
 * exactly cover `bandDim`.
 */
function planTilingAxis(
  bandDim: number,
  maxDimension: number,
  overlapPx: number,
): TilingAxisPlan {
  if (bandDim <= maxDimension) {
    return { count: 1, sizes: [bandDim], positions: [0] }
  }

  const maxStride = Math.max(1, maxDimension - overlapPx)
  const count = Math.max(1, Math.ceil((bandDim - overlapPx) / maxStride))
  const totalSize = bandDim + (count - 1) * overlapPx
  const baseSize = Math.floor(totalSize / count)
  const extraTiles = totalSize % count

  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    sizes.push(baseSize + (i < extraTiles ? 1 : 0))
  }

  const positions: number[] = [0]
  for (let i = 1; i < count; i++) {
    positions.push(positions[i - 1] + sizes[i - 1] - overlapPx)
  }

  return { count, sizes, positions }
}

/** Mirror a tile grid so a context-at-start plan becomes context-at-end. */
function mirrorAxisPlan(plan: TilingAxisPlan, bandDim: number): TilingAxisPlan {
  const mirrored = plan.positions.map((pos, i) => ({
    pos: bandDim - pos - plan.sizes[i],
    size: plan.sizes[i],
  }))
  mirrored.sort((a, b) => a.pos - b.pos)
  return {
    count: mirrored.length,
    positions: mirrored.map((entry) => entry.pos),
    sizes: mirrored.map((entry) => entry.size),
  }
}

/**
 * Compute the context-strip size for one axis so that the first tile is as
 * wide as `maxDimension` allows.
 *
 * The first tile always starts at band position 0.  To fill it to the
 * maximum, the context strip should occupy `maxDimension − extensionSize`
 * pixels.  We cap it at the actual image dimension (can't copy more than the
 * full image) and use a floor of 25 % of `maxDimension` for very-wide images
 * where the extension alone nearly reaches the cap.
 */
function maxContextSize(imageDimension: number, extensionSize: number, maxDimension: number): number {
  const ideal = maxDimension - extensionSize
  const floor = Math.round(maxDimension * 0.25)
  return Math.min(imageDimension, Math.max(floor, ideal))
}

/**
 * Plan a tiled full-resolution extension.
 *
 * Splits the extension band into an overlapping grid of tiles ≤ maxDimension²,
 * with both axes evenly distributing tile sizes (no tile is ever left as a
 * tiny sliver). Tiling always starts at position 0 — the context-strip
 * origin — on every axis, so the strip always sits inside whichever tile(s)
 * cover the start of the band. Returns tiles in context-to-extension scan
 * order:
 *   down  → rows top-to-bottom,    cols left-to-right
 *   up    → rows bottom-to-top,    cols left-to-right
 *   right → cols left-to-right,    rows top-to-bottom
 *   left  → cols right-to-left,    rows top-to-bottom
 *
 * Because the running band canvas is seeded with the original context strip
 * before the first tile is generated, every tile after the first in each scan
 * axis sees real painted content on its already-processed edges.
 *
 * The context-strip size is capped so a single tile covers the whole band
 * whenever possible (i.e. contextSize = min(imageDimension, maxDimension −
 * extensionSize), floored at 25% of maxDimension). Multi-tile plans only
 * arise once that floor kicks in, at which point the strip is always much
 * smaller than a single evenly-sized tile, so it's guaranteed to fit intact.
 */
export function planExtensionTiles(params: PlanExtensionTilesParams): TiledExtensionPlan {
  const {
    direction, imageWidth, imageHeight,
    extensionPercent,
    maxDimension, tileOverlapPx, maxTiles,
  } = params

  const extAmt = extensionPercent / 100

  let bandWidth: number
  let bandHeight: number
  let contextSize: number
  let extensionSize: number

  if (direction === 'down' || direction === 'up') {
    extensionSize = Math.round(imageHeight * extAmt)
    contextSize   = maxContextSize(imageHeight, extensionSize, maxDimension)
    bandWidth    = imageWidth
    bandHeight   = contextSize + extensionSize
  } else {
    extensionSize = Math.round(imageWidth * extAmt)
    contextSize   = maxContextSize(imageWidth, extensionSize, maxDimension)
    bandWidth    = contextSize + extensionSize
    bandHeight   = imageHeight
  }

  // The context strip always sits at the start of the band (position 0), and
  // planTilingAxis already anchors its first tile there — so the extension
  // axis uses the exact same even-distribution logic as the cross axis. This
  // guarantees uniformly-sized tiles across the whole band; the (much
  // smaller, floor-clamped) context strip is always fully contained within
  // whichever tile ends up at position 0.
  const isHorizontalExt = direction === 'left' || direction === 'right'

  const xPlan = isHorizontalExt
    ? (direction === 'right'
      ? planTilingAxis(bandWidth, maxDimension, tileOverlapPx)
      : mirrorAxisPlan(planTilingAxis(bandWidth, maxDimension, tileOverlapPx), bandWidth))
    : planTilingAxis(bandWidth, maxDimension, tileOverlapPx)

  const yPlan = isHorizontalExt
    ? planTilingAxis(bandHeight, maxDimension, tileOverlapPx)
    : (direction === 'down'
      ? planTilingAxis(bandHeight, maxDimension, tileOverlapPx)
      : mirrorAxisPlan(planTilingAxis(bandHeight, maxDimension, tileOverlapPx), bandHeight))
  const cols = xPlan.count
  const rows = yPlan.count

  if (rows * cols > maxTiles) {
    throw new Error(
      `Tiled extension requires ${rows * cols} tiles (${rows} rows × ${cols} cols), ` +
      `exceeding the limit of ${maxTiles}. Reduce image size or increase MAX_TILES_PER_EXTEND.`,
    )
  }

  // Build scan order arrays
  const rowOrder = direction === 'up'
    ? Array.from({ length: rows }, (_, i) => rows - 1 - i)
    : Array.from({ length: rows }, (_, i) => i)
  const colOrder = direction === 'left'
    ? Array.from({ length: cols }, (_, i) => cols - 1 - i)
    : Array.from({ length: cols }, (_, i) => i)

  const processedSet = new Set<string>()
  const tiles: ExtensionTileSpec[] = []

  for (const row of rowOrder) {
    for (const col of colOrder) {
      const bandX       = xPlan.positions[col]
      const bandY       = yPlan.positions[row]
      const actualTileW = xPlan.sizes[col]
      const actualTileH = yPlan.sizes[row]

      // Compute the gray (blank) region within this tile in tile-local coords,
      // based on the initial band state from initBandCanvas().
      let blankRegion: { x: number; y: number; width: number; height: number }
      switch (direction) {
        case 'down': {
          const gy = Math.max(0, contextSize - bandY)
          blankRegion = { x: 0, y: gy, width: actualTileW, height: Math.max(0, actualTileH - gy) }
          break
        }
        case 'up': {
          const gyEnd = Math.min(actualTileH, Math.max(0, extensionSize - bandY))
          blankRegion = { x: 0, y: 0, width: actualTileW, height: gyEnd }
          break
        }
        case 'right': {
          const gx = Math.max(0, contextSize - bandX)
          blankRegion = { x: gx, y: 0, width: Math.max(0, actualTileW - gx), height: actualTileH }
          break
        }
        case 'left': {
          const gxEnd = Math.min(actualTileW, Math.max(0, extensionSize - bandX))
          blankRegion = { x: 0, y: 0, width: gxEnd, height: actualTileH }
          break
        }
      }

      // Feather overlap: edges facing tiles already processed in scan order.
      const topPrev = processedSet.has(`${row - 1},${col}`)
      const botPrev = processedSet.has(`${row + 1},${col}`)
      const lftPrev = processedSet.has(`${row},${col - 1}`)
      const rgtPrev = processedSet.has(`${row},${col + 1}`)

      tiles.push({
        row, col, totalRows: rows, totalCols: cols,
        bandX, bandY,
        tileWidth: actualTileW, tileHeight: actualTileH,
        blankRegion,
        featherOverlap: {
          top:    topPrev ? tileOverlapPx : 0,
          bottom: botPrev ? tileOverlapPx : 0,
          left:   lftPrev ? tileOverlapPx : 0,
          right:  rgtPrev ? tileOverlapPx : 0,
        },
      })

      processedSet.add(`${row},${col}`)
    }
  }

  // Synthetic ChunkInfo for the final stitchExtendedChunk() call.
  const bandChunkInfo: ChunkInfo = {
    direction,
    originalWidth:  imageWidth,
    originalHeight: imageHeight,
    chunkWidth:  direction === 'left' || direction === 'right' ? contextSize : imageWidth,
    chunkHeight: direction === 'up'   || direction === 'down'  ? contextSize : imageHeight,
    extensionSize,
    sourceX: direction === 'right' ? imageWidth  - contextSize : 0,
    sourceY: direction === 'down'  ? imageHeight - contextSize : 0,
    scale: 1,
  }

  return { tiles, bandWidth, bandHeight, bandChunkInfo }
}

/**
 * Initialise the running band canvas.
 *
 * Creates a bandWidth × bandHeight canvas filled with EXTENSION_BLANK_COLOR,
 * then copies the context strip (the overlap region the AI will use as
 * continuation seed) from the source image:
 *   down  — bottom contextSize rows → band top
 *   up    — top    contextSize rows → band bottom
 *   right — right  contextSize cols → band left
 *   left  — left   contextSize cols → band right
 */
export function initBandCanvas(
  sourceImageDataUrl: string,
  direction: 'up' | 'down' | 'left' | 'right',
  bandWidth: number,
  bandHeight: number,
  contextSize: number,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = bandWidth
      canvas.height = bandHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get band canvas context'))
        return
      }

      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(0, 0, bandWidth, bandHeight)

      switch (direction) {
        case 'down':
          // Bottom contextSize rows of source → top of band
          ctx.drawImage(img, 0, img.height - contextSize, img.width, contextSize,
            0, 0, bandWidth, contextSize)
          break
        case 'up':
          // Top contextSize rows of source → bottom of band
          ctx.drawImage(img, 0, 0, img.width, contextSize,
            0, bandHeight - contextSize, bandWidth, contextSize)
          break
        case 'right':
          // Right contextSize cols of source → left of band
          ctx.drawImage(img, img.width - contextSize, 0, contextSize, img.height,
            0, 0, contextSize, bandHeight)
          break
        case 'left':
          // Left contextSize cols of source → right of band
          ctx.drawImage(img, 0, 0, contextSize, img.height,
            bandWidth - contextSize, 0, contextSize, bandHeight)
          break
      }

      resolve(canvas)
    }
    img.onerror = () => reject(new Error('Failed to load source image for band canvas init'))
    img.src = sourceImageDataUrl
  })
}

/**
 * Build the ChunkInfo descriptor for a single tile of a tiled extension.
 *
 * Extracted from the executeTiledPlan loop so page.tsx and the
 * TileExtensionModal can both derive the exact same ChunkInfo without
 * duplicating logic.
 */
export function buildTileChunkInfo(
  tileSpec: ExtensionTileSpec,
  direction: 'up' | 'down' | 'left' | 'right',
  nsIdx: number,
  nonSkippedCount: number,
): ChunkInfo {
  const blankR = tileSpec.blankRegion
  const contextAtStart = direction === 'right' || direction === 'down'

  let chunkWidth: number
  let chunkHeight: number
  let sourceX: number
  let sourceY: number
  let extensionSize: number

  if (direction === 'left' || direction === 'right') {
    chunkHeight = tileSpec.tileHeight
    extensionSize = blankR.width
    if (contextAtStart) {
      chunkWidth = blankR.x
      sourceX = 0
    } else {
      chunkWidth = tileSpec.tileWidth - blankR.width
      sourceX = blankR.width
    }
    sourceY = blankR.y
  } else {
    chunkWidth = tileSpec.tileWidth
    extensionSize = blankR.height
    if (contextAtStart) {
      chunkHeight = blankR.y
      sourceY = 0
    } else {
      chunkHeight = tileSpec.tileHeight - blankR.height
      sourceY = blankR.height
    }
    sourceX = blankR.x
  }

  return {
    direction,
    originalWidth: tileSpec.tileWidth,
    originalHeight: tileSpec.tileHeight,
    chunkWidth,
    chunkHeight,
    extensionSize,
    sourceX,
    sourceY,
    scale: 1,
    tileIndex: nsIdx,
    tileCount: nonSkippedCount,
  }
}

/**
 * Crop the tile's region from the running band canvas and return it as a
 * full-resolution JPEG suitable for the /api/extend endpoint.
 *
 * At call time the band already contains real pixels for all tiles processed
 * before this one in scan order, so the AI sees context on those edges and
 * gray only in the region it must fill.
 */
export function buildTileInput(
  bandCanvas: HTMLCanvasElement,
  tileSpec: ExtensionTileSpec,
): string {
  const { bandX, bandY, tileWidth, tileHeight } = tileSpec
  const tile = document.createElement('canvas')
  tile.width  = tileWidth
  tile.height = tileHeight
  const ctx = tile.getContext('2d')
  if (!ctx) throw new Error('Failed to get tile input canvas context')
  ctx.drawImage(bandCanvas, bandX, bandY, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)
  return tile.toDataURL('image/jpeg', 0.95)
}

/**
 * Draw a lightly softened planning guide into the tile blank region.
 *
 * Plan slices live at map scale (only downscaled to fit `MAX_AI_DIMENSION`).
 * Upscaling them sharp can leave pixel-grid structure the model copies; a
 * light blur proportional to the upscale factor softens that without wiping
 * the plan detail Phase 3 needs for guided super-resolution.
 */
export function drawSoftenedPlanningGuide(
  ctx: CanvasRenderingContext2D,
  sliceImg: HTMLImageElement,
  blankRegion: { x: number; y: number; width: number; height: number },
): void {
  const scale = Math.max(
    blankRegion.width / Math.max(1, sliceImg.naturalWidth),
    blankRegion.height / Math.max(1, sliceImg.naturalHeight),
  )
  // Lighter than the old curve (was scale×1.5, floor 8, cap 48).
  const blurPx = scale > 1.5
    ? Math.min(16, Math.max(3, Math.round(scale * 0.5)))
    : 0

  const guide = document.createElement('canvas')
  guide.width = blankRegion.width
  guide.height = blankRegion.height
  const gctx = guide.getContext('2d')
  if (!gctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      sliceImg,
      0, 0, sliceImg.naturalWidth, sliceImg.naturalHeight,
      blankRegion.x, blankRegion.y, blankRegion.width, blankRegion.height,
    )
    return
  }

  gctx.imageSmoothingEnabled = true
  gctx.imageSmoothingQuality = 'high'
  if (blurPx > 0) {
    gctx.filter = `blur(${blurPx}px)`
  }
  gctx.drawImage(sliceImg, 0, 0, blankRegion.width, blankRegion.height)
  gctx.filter = 'none'

  ctx.drawImage(guide, blankRegion.x, blankRegion.y)
}

/** Axis-aligned rect in tile-local pixel coordinates. */
interface TileLocalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Tile-local rects inside `blankRegion` that already have accepted-neighbour
 * content in the band. These must not be overwritten by a later tile's AI
 * output ("prior wins" in overlap).
 */
function collectAcceptedNeighbourLockRects(
  tileSpec: ExtensionTileSpec,
  allTileSpecs: ExtensionTileSpec[] | undefined,
  tileAccepted: boolean[] | undefined,
): TileLocalRect[] {
  if (!allTileSpecs || !tileAccepted) {
    return []
  }

  const { bandX, bandY, blankRegion } = tileSpec
  const curBandX = bandX + blankRegion.x
  const curBandY = bandY + blankRegion.y
  const curBandR = curBandX + blankRegion.width
  const curBandB = curBandY + blankRegion.height
  const rects: TileLocalRect[] = []

  for (let i = 0; i < allTileSpecs.length; i++) {
    if (!tileAccepted[i]) {
      continue
    }
    const nb = allTileSpecs[i]
    // Skip self (identity check by position).
    if (nb.bandX === tileSpec.bandX && nb.bandY === tileSpec.bandY) {
      continue
    }

    const nbBandX = nb.bandX + nb.blankRegion.x
    const nbBandY = nb.bandY + nb.blankRegion.y
    const nbBandR = nbBandX + nb.blankRegion.width
    const nbBandB = nbBandY + nb.blankRegion.height

    const ix = Math.max(curBandX, nbBandX)
    const iy = Math.max(curBandY, nbBandY)
    const ir = Math.min(curBandR, nbBandR)
    const ib = Math.min(curBandB, nbBandB)

    if (ir <= ix || ib <= iy) {
      continue
    }

    rects.push({
      x: ix - bandX,
      y: iy - bandY,
      width: ir - ix,
      height: ib - iy,
    })
  }

  return rects
}

/**
 * Restore accepted-neighbour pixels that overlap with the current tile's blank
 * region after the plan guide has been drawn over the full blank area.
 *
 * When a tile is part of a multi-tile grid some accepted neighbours share rows
 * or columns with the current tile's blank region (e.g. the tile directly above
 * in the same column).  Those pixels are already correct in the band canvas
 * from step 1, but step 2 (drawing the plan guide over the full blankRegion)
 * overwrites them.  This function redraws just those intersections from the
 * band canvas so the model sees high-res content where it is available.
 */
function restoreAcceptedNeighbourOverlaps(
  ctx: CanvasRenderingContext2D,
  bandCanvas: HTMLCanvasElement,
  tileSpec: ExtensionTileSpec,
  allTileSpecs: ExtensionTileSpec[],
  tileAccepted: boolean[],
): void {
  const { bandX, bandY } = tileSpec
  const rects = collectAcceptedNeighbourLockRects(tileSpec, allTileSpecs, tileAccepted)

  for (const rect of rects) {
    ctx.drawImage(
      bandCanvas,
      bandX + rect.x, bandY + rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height,
    )
  }
}

/**
 * Composite a tile input image with a planning guide in the blank region.
 *
 * Used by the TileExtensionModal preview so the user sees the same plan
 * placement that Phase 3 refine receives (light soften on upsample).
 *
 * Pass `allTileSpecs` + `tileAccepted` and a live `bandCanvas` so that
 * accepted-neighbour overlaps can be restored with high-res pixels after the
 * plan guide is drawn.
 */
export function compositeTileInputWithPlanning(
  inputImageUrl: string,
  tileSpec: ExtensionTileSpec,
  planningSlice: string,
  bandCanvas?: HTMLCanvasElement | null,
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
): Promise<string> {
  return Promise.all([loadImageElement(inputImageUrl), loadImageElement(planningSlice)])
    .then(([inputImg, sliceImg]) => {
      const { tileWidth, tileHeight, blankRegion } = tileSpec
      const composite = document.createElement('canvas')
      composite.width = tileWidth
      composite.height = tileHeight
      const ctx = composite.getContext('2d')
      if (!ctx) {
        return planningSlice
      }
      ctx.drawImage(inputImg, 0, 0)
      drawSoftenedPlanningGuide(ctx, sliceImg, blankRegion)
      // Restore high-res pixels from accepted neighbours that overlap the blank region.
      if (bandCanvas && allTileSpecs && tileAccepted) {
        restoreAcceptedNeighbourOverlaps(ctx, bandCanvas, tileSpec, allTileSpecs, tileAccepted)
      }
      return composite.toDataURL('image/png')
    })
    .catch(() => planningSlice)
}

/**
 * Build the composite IMAGE 1 sent to the Phase 3 refine API call.
 *
 * Layout:
 *   - High-res context strip from the band canvas (preserved exactly).
 *   - Low-res plan guide lightly softened into the blank region (layout +
 *     colour preserved; only previously downscaled to fit the API limit).
 *   - High-res pixels from accepted neighbour tiles restored on top of the
 *     plan guide wherever they overlap the current tile's blank region
 *     (e.g. the tile directly above in the same column).
 *
 * Falls back to the plain tile input if the planning slice fails to load.
 */
export function buildTileSliceComposite(
  bandCanvas: HTMLCanvasElement,
  tileSpec: ExtensionTileSpec,
  planningSlice: string,
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
): Promise<string> {
  return new Promise((resolve) => {
    const { bandX, bandY, tileWidth, tileHeight, blankRegion } = tileSpec

    const composite = document.createElement('canvas')
    composite.width  = tileWidth
    composite.height = tileHeight
    const ctx = composite.getContext('2d')
    if (!ctx) {
      resolve(buildTileInput(bandCanvas, tileSpec))
      return
    }

    // Step 1: full tile from band canvas (context strip + real pixels from
    // any accepted tiles that overlap, grey for everything else).
    ctx.drawImage(bandCanvas, bandX, bandY, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)

    const sliceImg = new Image()
    sliceImg.onload = () => {
      // Step 2: lightly softened plan guide over the full blank region
      // (overwrites any accepted-neighbour pixels inside blankRegion).
      drawSoftenedPlanningGuide(ctx, sliceImg, blankRegion)

      // Step 3: restore accepted-neighbour overlaps with high-res pixels so
      // the model sees real content where it is already available.
      if (allTileSpecs && tileAccepted) {
        restoreAcceptedNeighbourOverlaps(ctx, bandCanvas, tileSpec, allTileSpecs, tileAccepted)
      }

      resolve(composite.toDataURL('image/png'))
    }
    sliceImg.onerror = () => resolve(buildTileInput(bandCanvas, tileSpec))
    sliceImg.src = planningSlice
  })
}

/** Red used for future-tile regions on the legacy per-tile planning map. */
const PLANNING_MAP_FUTURE_COLOR = '#FF0000'

// ─── Tile-region rect type ────────────────────────────────────────────────────

export interface PlanTileRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Build a scaled-down planning map for the GLOBAL extension plan (Phase 1).
 *
 * Unlike the legacy per-tile planning map, this version:
 *   - Paints the ENTIRE extension zone grey (#B0B0B0) — no red future-tile markers.
 *   - Already-accepted tile regions show their real pixels from the band canvas.
 *   - Returns `tileRegionsInMap`: one crop-rect per non-skipped tile spec, in
 *     map-scale coordinates, so each tile's portion of the plan result can be
 *     cropped out by the caller.
 *
 * The full scene (source image + extension area) is scaled to fit within
 * `maxDim` on the longest edge, matching the legacy function's behaviour.
 */
export function buildGlobalPlanningMap(
  sourceImageDataUrl: string,
  bandCanvas: HTMLCanvasElement,
  allTileSpecs: ExtensionTileSpec[],
  acceptedMask: boolean[],
  direction: 'up' | 'down' | 'left' | 'right',
  imageWidth: number,
  imageHeight: number,
  contextSize: number,
  extensionSize: number,
  maxDim = 1024,
): Promise<{
  mapDataUrl: string
  mapWidth: number
  mapHeight: number
  tileRegionsInMap: PlanTileRegion[]
}> {
  return new Promise((resolve) => {
    const fallback = (w: number, h: number) => ({
      mapDataUrl: bandCanvas.toDataURL('image/jpeg', 0.85),
      mapWidth: w,
      mapHeight: h,
      tileRegionsInMap: allTileSpecs.map(() => ({ x: 0, y: 0, width: w, height: h })),
    })

    const srcImg = new Image()
    srcImg.onload = () => {
      const isVertical = direction === 'down' || direction === 'up'
      const sceneW = isVertical ? imageWidth : imageWidth + extensionSize
      const sceneH = isVertical ? imageHeight + extensionSize : imageHeight

      const srcOffsetX = direction === 'left' ? extensionSize : 0
      const srcOffsetY = direction === 'up'   ? extensionSize : 0
      const extOffsetX = direction === 'right' ? imageWidth  : 0
      const extOffsetY = direction === 'down'  ? imageHeight : 0

      // Band coords share the scene origin on the extension side (band 0 → scene 0).
      // Context-at-end directions (left / up) mirror the band layout but not the offset.
      const bandToSceneX = (bx: number): number => {
        if (direction === 'right') return (imageWidth - contextSize) + bx
        return bx
      }
      const bandToSceneY = (by: number): number => {
        if (direction === 'down') return (imageHeight - contextSize) + by
        return by
      }

      const scale = Math.min(1, maxDim / Math.max(sceneW, sceneH))
      const outW  = Math.max(1, Math.round(sceneW * scale))
      const outH  = Math.max(1, Math.round(sceneH * scale))

      const map = document.createElement('canvas')
      map.width  = outW
      map.height = outH
      const ctx = map.getContext('2d')
      if (!ctx) {
        resolve(fallback(outW, outH))
        return
      }

      const extSceneW = isVertical ? imageWidth    : extensionSize
      const extSceneH = isVertical ? extensionSize : imageHeight
      const extSX = Math.round(extOffsetX * scale)
      const extSY = Math.round(extOffsetY * scale)
      const extSW = Math.max(1, Math.round(extSceneW * scale))
      const extSH = Math.max(1, Math.round(extSceneH * scale))

      // Step 1: source image
      ctx.drawImage(
        srcImg, 0, 0, imageWidth, imageHeight,
        Math.round(srcOffsetX * scale), Math.round(srcOffsetY * scale),
        Math.max(1, Math.round(imageWidth  * scale)),
        Math.max(1, Math.round(imageHeight * scale)),
      )

      // Step 2: paint the ENTIRE extension zone grey (no red)
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(extSX, extSY, extSW, extSH)

      // Step 3: restore accepted tiles with real pixels
      for (let i = 0; i < allTileSpecs.length; i++) {
        if (!acceptedMask[i]) continue
        const spec = allTileSpecs[i]
        const br   = spec.blankRegion
        if (br.width === 0 || br.height === 0) continue
        const bBandX = spec.bandX + br.x
        const bBandY = spec.bandY + br.y
        const sX = Math.round(bandToSceneX(bBandX) * scale)
        const sY = Math.round(bandToSceneY(bBandY) * scale)
        const sW = Math.max(1, Math.round(br.width  * scale))
        const sH = Math.max(1, Math.round(br.height * scale))
        ctx.drawImage(bandCanvas, bBandX, bBandY, br.width, br.height, sX, sY, sW, sH)
      }

      // Step 4: compute each tile's blank region in map-scale coordinates
      const tileRegionsInMap: PlanTileRegion[] = allTileSpecs.map((spec) => {
        const br = spec.blankRegion
        if (br.width === 0 || br.height === 0) {
          return { x: 0, y: 0, width: 0, height: 0 }
        }
        const bBandX = spec.bandX + br.x
        const bBandY = spec.bandY + br.y
        return {
          x:      Math.round(bandToSceneX(bBandX) * scale),
          y:      Math.round(bandToSceneY(bBandY) * scale),
          width:  Math.max(1, Math.round(br.width  * scale)),
          height: Math.max(1, Math.round(br.height * scale)),
        }
      })

      resolve({ mapDataUrl: map.toDataURL('image/jpeg', 0.90), mapWidth: outW, mapHeight: outH, tileRegionsInMap })
    }

    srcImg.onerror = () => resolve(fallback(bandCanvas.width, bandCanvas.height))
    srcImg.crossOrigin = 'anonymous'
    srcImg.src = sourceImageDataUrl
  })
}

/**
 * Build a per-tile re-plan map from the global plan result.
 *
 * Loads `globalPlanResult`, then paints the current tile's region grey so the
 * model fills just that tile while seeing the rest of the already-planned
 * extension as context.  Used for Phase 2 (per-tile plan override).
 */
export function buildPerTilePlanningMap(
  globalPlanResult: string,
  tileRegionInMap: PlanTileRegion,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(globalPlanResult)
        return
      }
      ctx.drawImage(img, 0, 0)
      // Grey out this tile's region so the model re-fills only that area.
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      ctx.fillRect(tileRegionInMap.x, tileRegionInMap.y, tileRegionInMap.width, tileRegionInMap.height)
      resolve(canvas.toDataURL('image/jpeg', 0.90))
    }
    img.onerror = () => reject(new Error('Failed to load global plan result for per-tile map'))
    img.crossOrigin = 'anonymous'
    img.src = globalPlanResult
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Regional plans — for extensions whose scene is far larger than a single
// whole-scene plan can usefully represent. Instead of one plan covering the
// entire extension at a heavy downscale, the tile grid is grouped into a
// handful of regions, each planned independently at the full MAX_AI_DIMENSION
// budget. See groupTilesIntoPlanRegions() and buildRegionalPlanningMap().
// ─────────────────────────────────────────────────────────────────────────────

/** Position + size of one axis slot (tile column or row) in band pixels. */
interface AxisExtent {
  pos: number
  size: number
}

/**
 * Greedily group consecutive axis slots (tile columns or rows) so each
 * group's span stays within `maxSpan`, with `overlapCount` slots shared
 * between consecutive groups for seam continuity. Mirrors planTilingAxis's
 * "as many as fit" logic, but groups whole tiles instead of raw pixels.
 *
 * Every group contains at least one slot beyond its start, even if that
 * single slot alone already exceeds maxSpan — a group can never be empty.
 */
function greedyAxisGroups(extents: AxisExtent[], maxSpan: number, overlapCount: number): number[][] {
  const n = extents.length
  if (n === 0) return []
  const groups: number[][] = []
  let start = 0
  while (start < n) {
    let end = start
    while (end + 1 < n) {
      const candidateEnd = end + 1
      const span = (extents[candidateEnd].pos + extents[candidateEnd].size) - extents[start].pos
      if (span <= maxSpan || end === start) {
        end = candidateEnd
      } else {
        break
      }
    }
    const group: number[] = []
    for (let i = start; i <= end; i++) group.push(i)
    groups.push(group)
    if (end >= n - 1) break
    start = overlapCount > 0 ? Math.max(start + 1, end - overlapCount + 1) : end + 1
  }
  return groups
}

/** One region of a regionally-planned extension. */
export interface PlanRegionSpec {
  /** Sequential generation order — also this region's index into the flattened regions array. */
  index: number
  /** Tile row indices (into the full grid) this region covers. */
  rowGroup: number[]
  /** Tile column indices (into the full grid) this region covers. */
  colGroup: number[]
  /** Bounding rect of this region in band-canvas coordinates. */
  bandRect: { x: number; y: number; width: number; height: number }
}

export interface PlanRegionGrouping {
  /** Regions in generation order. */
  regions: PlanRegionSpec[]
  /**
   * Index of the region that OWNS tile (row, col) — the first region
   * (generation order) whose row/col group covers it. Later regions that
   * share an overlap tile with an earlier one never re-decide it; they only
   * read it as already-decided context. Returns -1 if the tile isn't part
   * of any region (shouldn't happen for tiles actually present in the grid).
   */
  regionOf: (row: number, col: number) => number
}

/**
 * Group a tile grid into planning regions so each region's scene-space span
 * stays within `maxSceneDim` per axis, instead of one whole-scene plan that
 * gets more compressed the larger the source image is.
 *
 * Grouping happens independently on both axes (rows and columns) and regions
 * are the cross product — in the common case one axis fits in a single group
 * so this reduces to grouping along the other axis only, but it generalises
 * to extensions where both axes are large.
 *
 * Throws if the resulting region count exceeds `maxRegions` (cost guard,
 * mirrors planExtensionTiles' maxTiles check).
 */
export function groupTilesIntoPlanRegions(
  nonSkippedTileSpecs: ExtensionTileSpec[],
  maxSceneDim: number,
  overlapTiles: number,
  maxRegions: number,
): PlanRegionGrouping {
  if (nonSkippedTileSpecs.length === 0) {
    return { regions: [], regionOf: () => -1 }
  }

  const totalRows = nonSkippedTileSpecs[0].totalRows
  const totalCols = nonSkippedTileSpecs[0].totalCols

  const colExtents: AxisExtent[] = new Array(totalCols).fill(null).map(() => ({ pos: 0, size: 0 }))
  const rowExtents: AxisExtent[] = new Array(totalRows).fill(null).map(() => ({ pos: 0, size: 0 }))
  const colSeen = new Array<boolean>(totalCols).fill(false)
  const rowSeen = new Array<boolean>(totalRows).fill(false)
  for (const t of nonSkippedTileSpecs) {
    if (!colSeen[t.col]) { colExtents[t.col] = { pos: t.bandX, size: t.tileWidth }; colSeen[t.col] = true }
    if (!rowSeen[t.row]) { rowExtents[t.row] = { pos: t.bandY, size: t.tileHeight }; rowSeen[t.row] = true }
  }

  const colGroups = greedyAxisGroups(colExtents, maxSceneDim, overlapTiles)
  const rowGroups = greedyAxisGroups(rowExtents, maxSceneDim, overlapTiles)

  if (rowGroups.length * colGroups.length > maxRegions) {
    throw new Error(
      `Regional planning requires ${rowGroups.length * colGroups.length} regions ` +
      `(${rowGroups.length} row-group(s) × ${colGroups.length} col-group(s)), exceeding the limit of ${maxRegions}.`
    )
  }

  // Earliest group index containing each row/col — a shared boundary slot
  // belongs to two groups; the earlier one owns it.
  const rowGroupOfRow = new Array<number>(totalRows).fill(-1)
  rowGroups.forEach((g, gi) => { for (const r of g) if (rowGroupOfRow[r] === -1) rowGroupOfRow[r] = gi })
  const colGroupOfCol = new Array<number>(totalCols).fill(-1)
  colGroups.forEach((g, gi) => { for (const c of g) if (colGroupOfCol[c] === -1) colGroupOfCol[c] = gi })

  const regionIndexByGroup: number[][] = rowGroups.map(() => new Array<number>(colGroups.length).fill(-1))
  const regions: PlanRegionSpec[] = []
  for (let rg = 0; rg < rowGroups.length; rg++) {
    for (let cg = 0; cg < colGroups.length; cg++) {
      const rows = rowGroups[rg]
      const cols = colGroups[cg]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const t of nonSkippedTileSpecs) {
        if (!rows.includes(t.row) || !cols.includes(t.col)) continue
        minX = Math.min(minX, t.bandX)
        minY = Math.min(minY, t.bandY)
        maxX = Math.max(maxX, t.bandX + t.tileWidth)
        maxY = Math.max(maxY, t.bandY + t.tileHeight)
      }
      // No surviving (non-skipped) tile lands in this row/col combination —
      // skip creating an empty region for it.
      if (!Number.isFinite(minX)) continue
      regionIndexByGroup[rg][cg] = regions.length
      regions.push({
        index: regions.length,
        rowGroup: rows,
        colGroup: cols,
        bandRect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      })
    }
  }

  const regionOf = (row: number, col: number): number => {
    const rg = rowGroupOfRow[row]
    const cg = colGroupOfCol[col]
    if (rg === -1 || cg === -1) return -1
    return regionIndexByGroup[rg][cg]
  }

  return { regions, regionOf }
}

/** A previously-generated region's plan result, needed to carry overlap-tile continuity forward. */
export interface PriorRegionResult {
  resultUrl: string
  /** Scale factor from band-canvas pixels to that region's map pixels. */
  scale: number
  bandRect: { x: number; y: number; width: number; height: number }
}

export interface RegionalPlanningMapResult {
  mapDataUrl: string
  mapWidth: number
  mapHeight: number
  /** Scale factor from band-canvas pixels to this region's map pixels. */
  scale: number
  /**
   * Map-scale blank-region rect for each tile NEWLY owned by this region
   * (i.e. this is the region that must fill it), keyed by index into
   * `nonSkippedTileSpecs`. Tiles owned by an earlier region are absent —
   * this region only reads them as context, it never re-decides them.
   */
  tileRegionsInMap: Map<number, PlanTileRegion>
}

/** Axis parameters shared by every region of one extension, needed to derive
 * the extension-axis layout (Block A / Block B split) without depending on
 * a source image — used anywhere only the geometry (not the pixels) matters. */
export interface RegionAxisContext {
  direction: 'up' | 'down' | 'left' | 'right'
  imageWidth: number
  imageHeight: number
  /** The small, tile-oriented context strip size already baked into bandCanvas. */
  contextSize: number
  extensionSize: number
}

/** Scene-level parameters shared by every region of one extension — needed to
 * pull a much deeper "real image" context block straight from the original
 * source, independent of the small tile-oriented context strip already
 * baked into the band canvas. */
export interface RegionSceneContext extends RegionAxisContext {
  sourceImageDataUrl: string
}

/**
 * Layout of one region's plan map: it's composed of two blocks stacked along
 * the extension axis —
 *   Block A ("real image"): a deep crop straight from the ORIGINAL source
 *     image, sized to roughly match the extension depth (half real / half
 *     new), independent of the much thinner context strip tiles use.
 *   Block B ("new region tile"): this region's own extension-only slice of
 *     the band canvas (grey for undecided tiles, real pixels for any
 *     already-accepted ones, plus carried-forward overlap from earlier
 *     regions) — what the pre-existing implementation cropped alone.
 * For context-at-start directions (down/right) Block A precedes Block B;
 * for context-at-end directions (up/left) Block B precedes Block A.
 * Exported so every consumer (map builder, extension-view compositor,
 * Phase-2 per-tile re-plan, and the RegionPlanModal live preview) derives
 * the exact same pixel mapping from the same inputs — no separate state to
 * keep in sync.
 */
export interface RegionMapLayout {
  mapWidth: number
  mapHeight: number
  /** Scale factor from band-canvas px to map px (uniform on both axes). */
  scale: number
  /** Band coordinate (along the extension axis) where Block B's content starts. */
  blockBExtStart: number
  /** Band-scale size of Block B's content along the extension axis. */
  blockBExtSize: number
  /** Map-scale pixels of Block A preceding Block B (0 when Block A trails instead). */
  contextLeadPx: number
  /** Band-scale depth of Block A's original-image crop along the extension axis. */
  contextDepth: number
}

export function computeRegionMapLayout(
  scene: RegionAxisContext,
  bandRect: { x: number; y: number; width: number; height: number },
  maxDim: number,
): RegionMapLayout {
  const { direction, imageWidth, imageHeight, contextSize, extensionSize } = scene
  const isVertical = direction === 'down' || direction === 'up'
  const contextAtStart = direction === 'down' || direction === 'right'
  const bandDim = contextSize + extensionSize

  // Aim for roughly equal parts real image / new region tile, capped by how
  // much of the original image actually exists to draw from.
  const availableSourceDepth = isVertical ? imageHeight : imageWidth
  const desiredContextDepth = Math.min(extensionSize, availableSourceDepth)

  const crossSize = isVertical ? bandRect.width : bandRect.height
  const rectExtStart = isVertical ? bandRect.y : bandRect.x
  const rectExtSize = isVertical ? bandRect.height : bandRect.width
  const extRangeStart = contextAtStart ? contextSize : 0
  const extRangeEnd = contextAtStart ? bandDim : extensionSize
  const blockBExtStart = Math.max(rectExtStart, extRangeStart)
  const blockBExtEnd = Math.min(rectExtStart + rectExtSize, extRangeEnd)
  const blockBExtSize = Math.max(0, blockBExtEnd - blockBExtStart)

  const unscaledDepth = desiredContextDepth + blockBExtSize
  const scale = Math.min(1, maxDim / Math.max(crossSize, unscaledDepth))

  const outCross = Math.max(1, Math.round(crossSize * scale))
  const contextLeadPx = contextAtStart ? Math.round(desiredContextDepth * scale) : 0
  const blockBSizePx = Math.max(1, Math.round(blockBExtSize * scale))
  const outDepth = contextAtStart
    ? contextLeadPx + blockBSizePx
    : blockBSizePx + Math.round(desiredContextDepth * scale)

  return {
    mapWidth: isVertical ? outCross : outDepth,
    mapHeight: isVertical ? outDepth : outCross,
    scale,
    blockBExtStart,
    blockBExtSize,
    contextLeadPx,
    contextDepth: desiredContextDepth,
  }
}

/**
 * Map a tile's band-canvas-relative blank rect into a region's map-pixel
 * coordinate space, per the Block A / Block B layout in RegionMapLayout.
 * Shared by buildRegionalPlanningMap's own tileRegionsInMap and by the
 * Phase-2 per-tile re-plan path in page.tsx, so both always agree on
 * exactly where a tile's slice lives within a region's plan result image.
 */
export function mapTileRectIntoRegionLayout(
  scene: RegionAxisContext,
  bandRect: { x: number; y: number; width: number; height: number },
  layout: RegionMapLayout,
  tileBandX: number,
  tileBandY: number,
  tileWidth: number,
  tileHeight: number,
): PlanTileRegion {
  const isVertical = scene.direction === 'down' || scene.direction === 'up'
  const contextAtStart = scene.direction === 'down' || scene.direction === 'right'
  const tileExtCoord = isVertical ? tileBandY : tileBandX
  const tileCrossCoord = isVertical ? tileBandX : tileBandY
  const crossOrigin = isVertical ? bandRect.x : bandRect.y
  const extLocalPx = Math.round((tileExtCoord - layout.blockBExtStart) * layout.scale) + (contextAtStart ? layout.contextLeadPx : 0)
  const crossLocalPx = Math.round((tileCrossCoord - crossOrigin) * layout.scale)
  return {
    x: Math.round(isVertical ? crossLocalPx : extLocalPx),
    y: Math.round(isVertical ? extLocalPx : crossLocalPx),
    width: Math.max(1, Math.round(tileWidth * layout.scale)),
    height: Math.max(1, Math.round(tileHeight * layout.scale)),
  }
}

/**
 * Build the planning map for ONE region of a regionally-planned extension
 * (see groupTilesIntoPlanRegions).
 *
 * Composes two blocks along the extension axis (see RegionMapLayout):
 *   Block A — a deep crop straight from the ORIGINAL source image, sized to
 *     roughly match the extension depth, so the model has substantial real
 *     content to anchor its continuation against — not just tiles' thin
 *     context strip. It's fine (expected, even) for this to end up heavily
 *     downscaled/blurry: a region plan's job is broad coherence, not detail.
 *   Block B — this region's own extension-only slice of the band canvas
 *     (grey for undecided tiles, real pixels for already-accepted ones).
 *
 * The overlap tile(s) shared with an earlier region are not yet real pixels
 * in the band canvas (Phase 3 refine hasn't necessarily run for them).
 * Wherever such a tile isn't already accepted, this draws the earlier
 * region's plan result over the grey so the model sees continuity instead of
 * a hard grey seam — the plan-level equivalent of the tile overlap trick.
 */
export async function buildRegionalPlanningMap(
  bandCanvas: HTMLCanvasElement,
  nonSkippedTileSpecs: ExtensionTileSpec[],
  tileAccepted: boolean[],
  grouping: PlanRegionGrouping,
  region: PlanRegionSpec,
  priorRegionResults: Array<PriorRegionResult | null>,
  maxDim: number,
  scene: RegionSceneContext,
): Promise<RegionalPlanningMapResult> {
  const { bandRect } = region
  const isVertical = scene.direction === 'down' || scene.direction === 'up'
  const contextAtStart = scene.direction === 'down' || scene.direction === 'right'
  const layout = computeRegionMapLayout(scene, bandRect, maxDim)
  const { mapWidth: outW, mapHeight: outH, scale, blockBExtStart, blockBExtSize, contextLeadPx, contextDepth } = layout

  const map = document.createElement('canvas')
  map.width = outW
  map.height = outH
  const ctx = map.getContext('2d')
  if (!ctx) {
    return { mapDataUrl: bandCanvas.toDataURL('image/jpeg', 0.85), mapWidth: outW, mapHeight: outH, scale, tileRegionsInMap: new Map() }
  }

  const crossStart = isVertical ? bandRect.x : bandRect.y
  const crossSizeUnscaled = isVertical ? bandRect.width : bandRect.height
  const bSizePx = Math.max(1, Math.round(blockBExtSize * scale))
  const bLeadPx = contextAtStart ? contextLeadPx : 0
  const aLeadPx = contextAtStart ? 0 : bSizePx
  const aSizePx = Math.max(0, (isVertical ? outH : outW) - bSizePx)

  // ── Block A: deep, real context straight from the ORIGINAL image ───────
  // Deliberately much bigger than tiles' thin context strip — roughly half
  // the map, capped by how much of the source actually exists — so the
  // model has substantial real pixels to anchor against. Fine if blurry.
  try {
    if (contextDepth > 0 && aSizePx > 0) {
      const srcImg = await loadImageElement(scene.sourceImageDataUrl)
      if (isVertical) {
        const srcY = scene.direction === 'down' ? scene.imageHeight - contextDepth : 0
        ctx.drawImage(
          srcImg,
          crossStart, srcY, crossSizeUnscaled, contextDepth,
          0, aLeadPx, outW, aSizePx,
        )
      } else {
        const srcX = scene.direction === 'right' ? scene.imageWidth - contextDepth : 0
        ctx.drawImage(
          srcImg,
          srcX, crossStart, contextDepth, crossSizeUnscaled,
          aLeadPx, 0, aSizePx, outH,
        )
      }
    }
  } catch {
    // Original image failed to load — fall back to whatever Block B below
    // provides; not fatal, just less deep context this one time.
  }

  // ── Block B: this region's extension-only slice of the band canvas ─────
  if (blockBExtSize > 0) {
    if (isVertical) {
      ctx.drawImage(
        bandCanvas,
        bandRect.x, blockBExtStart, bandRect.width, blockBExtSize,
        0, bLeadPx, outW, bSizePx,
      )
    } else {
      ctx.drawImage(
        bandCanvas,
        blockBExtStart, bandRect.y, blockBExtSize, bandRect.height,
        bLeadPx, 0, bSizePx, outH,
      )
    }
  }

  const tileRegionsInMap = new Map<number, PlanTileRegion>()
  type OverlapDraw = { url: string; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }
  const draws: OverlapDraw[] = []

  for (let i = 0; i < nonSkippedTileSpecs.length; i++) {
    const t = nonSkippedTileSpecs[i]
    const ownerIdx = grouping.regionOf(t.row, t.col)
    const br = t.blankRegion
    if (br.width === 0 || br.height === 0) continue

    if (ownerIdx === region.index) {
      // Newly owned by this region — record its map-scale blank rect so the
      // caller can crop this tile's slice out of the plan result. Tiles only
      // ever live in Block B (the extension), so the ext-axis coordinate is
      // relative to blockBExtStart + the Block-A lead, not bandRect's origin.
      tileRegionsInMap.set(i, mapTileRectIntoRegionLayout(
        scene, bandRect, layout, t.bandX + br.x, t.bandY + br.y, br.width, br.height,
      ))
      continue
    }

    if (ownerIdx === -1 || tileAccepted[i]) continue
    const prior = priorRegionResults[ownerIdx]
    if (!prior) continue
    const priorLayout = computeRegionMapLayout(scene, grouping.regions[ownerIdx].bandRect, maxDim)

    const tileBandX = t.bandX + br.x
    const tileBandY = t.bandY + br.y
    const ix = Math.max(tileBandX, bandRect.x)
    const iy = Math.max(tileBandY, bandRect.y)
    const ir = Math.min(tileBandX + br.width, bandRect.x + bandRect.width)
    const ib = Math.min(tileBandY + br.height, bandRect.y + bandRect.height)
    if (ir <= ix || ib <= iy) continue

    const priorExtStart = isVertical ? iy : ix
    const priorExtEnd = isVertical ? ib : ir
    const priorCrossStart = isVertical ? ix : iy
    const priorCrossEnd = isVertical ? ir : ib

    const sExt = (priorExtStart - priorLayout.blockBExtStart) * prior.scale + priorLayout.contextLeadPx
    const sCross = (priorCrossStart - (isVertical ? prior.bandRect.x : prior.bandRect.y)) * prior.scale
    const sExtSize = (priorExtEnd - priorExtStart) * prior.scale
    const sCrossSize = (priorCrossEnd - priorCrossStart) * prior.scale

    const dExt = (priorExtStart - blockBExtStart) * scale + (contextAtStart ? contextLeadPx : 0)
    const dCross = (priorCrossStart - (isVertical ? bandRect.x : bandRect.y)) * scale
    const dExtSize = (priorExtEnd - priorExtStart) * scale
    const dCrossSize = (priorCrossEnd - priorCrossStart) * scale

    draws.push({
      url: prior.resultUrl,
      sx: isVertical ? sCross : sExt,
      sy: isVertical ? sExt : sCross,
      sw: isVertical ? sCrossSize : sExtSize,
      sh: isVertical ? sExtSize : sCrossSize,
      dx: isVertical ? dCross : dExt,
      dy: isVertical ? dExt : dCross,
      dw: isVertical ? dCrossSize : dExtSize,
      dh: isVertical ? dExtSize : dCrossSize,
    })
  }

  if (draws.length > 0) {
    try {
      const uniqueUrls = Array.from(new Set(draws.map((d) => d.url)))
      const images = await Promise.all(uniqueUrls.map((url) => loadImageElement(url)))
      const imageByUrl = new Map(uniqueUrls.map((url, i) => [url, images[i]] as const))
      for (const d of draws) {
        const img = imageByUrl.get(d.url)
        if (!img) continue
        ctx.drawImage(img, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh)
      }
    } catch {
      // A prior region's image failed to load — fall back to whatever's
      // already drawn. Not fatal; the model just sees a plainer seam this
      // one time.
    }
  }

  return {
    mapDataUrl: map.toDataURL('image/jpeg', 0.90),
    mapWidth: outW,
    mapHeight: outH,
    scale,
    tileRegionsInMap,
  }
}

/**
 * Composite every generated region's result into a single extension-only
 * background image for the tiling band UI — the regional-plan counterpart
 * of cropGlobalPlanExtensionView(). Regions without a result yet simply
 * leave their portion of the composite blank (transparent), which the
 * band UI already handles gracefully for a partially-planned extension.
 */
export async function buildRegionalExtensionView(
  regionResults: Array<PriorRegionResult | null>,
  viewport: { x: number; y: number; width: number; height: number },
  maxDim: number,
  scene: RegionAxisContext,
): Promise<string> {
  const isVertical = scene.direction === 'down' || scene.direction === 'up'
  const outScale = Math.min(1, maxDim / Math.max(viewport.width, viewport.height))
  const outW = Math.max(1, Math.round(viewport.width * outScale))
  const outH = Math.max(1, Math.round(viewport.height * outScale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  type Draw = { url: string; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }
  const draws: Draw[] = []
  for (const region of regionResults) {
    if (!region) continue
    const { bandRect } = region
    const ix = Math.max(bandRect.x, viewport.x)
    const iy = Math.max(bandRect.y, viewport.y)
    const ir = Math.min(bandRect.x + bandRect.width, viewport.x + viewport.width)
    const ib = Math.min(bandRect.y + bandRect.height, viewport.y + viewport.height)
    if (ir <= ix || ib <= iy) continue

    // The viewport is extension-only, so this intersection always lands
    // inside the region's Block B (never Block A's deep source context) —
    // but Block B may itself be offset within resultUrl by Block A's lead,
    // so the source sample must go through the same layout math used to
    // build resultUrl in the first place, not a naive bandRect-relative crop.
    const layout = computeRegionMapLayout(scene, bandRect, maxDim)
    const extStart = isVertical ? iy : ix
    const extEnd = isVertical ? ib : ir
    const crossStart = isVertical ? ix : iy
    const crossEnd = isVertical ? ir : ib
    const crossOrigin = isVertical ? bandRect.x : bandRect.y
    const contextAtStart = scene.direction === 'down' || scene.direction === 'right'

    const sExt = (extStart - layout.blockBExtStart) * region.scale + (contextAtStart ? layout.contextLeadPx : 0)
    const sCross = (crossStart - crossOrigin) * region.scale
    const sExtSize = (extEnd - extStart) * region.scale
    const sCrossSize = (crossEnd - crossStart) * region.scale

    draws.push({
      url: region.resultUrl,
      sx: isVertical ? sCross : sExt,
      sy: isVertical ? sExt : sCross,
      sw: isVertical ? sCrossSize : sExtSize,
      sh: isVertical ? sExtSize : sCrossSize,
      dx: (ix - viewport.x) * outScale,
      dy: (iy - viewport.y) * outScale,
      dw: (ir - ix) * outScale,
      dh: (ib - iy) * outScale,
    })
  }
  if (draws.length === 0) return ''

  try {
    const uniqueUrls = Array.from(new Set(draws.map((d) => d.url)))
    const images = await Promise.all(uniqueUrls.map((url) => loadImageElement(url)))
    const imageByUrl = new Map(uniqueUrls.map((url, i) => [url, images[i]] as const))
    for (const d of draws) {
      const img = imageByUrl.get(d.url)
      if (!img) continue
      ctx.drawImage(img, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh)
    }
  } catch {
    return ''
  }
  return canvas.toDataURL('image/jpeg', 0.90)
}

/**
 * Build a scaled-down planning map of the full scene for phase 1.
 *
 * Unlike the previous implementation which used only the narrow band canvas,
 * this version composites the complete source image together with the
 * extension area so the model has full spatial context (complete horizon,
 * sky/ground split, subject placement) when deciding what to put in the grey
 * fill region.
 *
 * Layout in full-scene coordinates:
 *   down  → source image on top,  extension rows below
 *   up    → extension rows on top, source image below
 *   right → source image on left, extension cols to the right
 *   left  → extension cols on left, source image to the right
 *
 * Colour regions in the extension area:
 *   - Already-accepted tiles   → real pixels (copied from band canvas)
 *   - Current tile blank region → EXTENSION_BLANK_COLOR (#B0B0B0)
 *   - Future tile blank regions → PLANNING_MAP_FUTURE_COLOR (#FF0000)
 *
 * The full scene is scaled to fit within `maxDim` on the longest edge.
 */
export function buildTilePlanningMap(
  sourceImageDataUrl: string,
  bandCanvas: HTMLCanvasElement,
  allTileSpecs: ExtensionTileSpec[],
  currentTileSpec: ExtensionTileSpec,
  acceptedMask: boolean[],
  direction: 'up' | 'down' | 'left' | 'right',
  imageWidth: number,
  imageHeight: number,
  contextSize: number,
  extensionSize: number,
  maxDim = 512,
): Promise<{ mapDataUrl: string; mapWidth: number; mapHeight: number; tileRegionInMap: { x: number; y: number; width: number; height: number } }> {
  return new Promise((resolve) => {
    const srcImg = new Image()
    srcImg.onload = () => {
      // ── Full-scene dimensions ────────────────────────────────────────────
      // The full scene is the source image + the extension strip laid out
      // adjacently. These are in unscaled "full-scene" pixel coordinates.
      const isVertical = direction === 'down' || direction === 'up'

      const sceneW = isVertical ? imageWidth          : imageWidth  + extensionSize
      const sceneH = isVertical ? imageHeight + extensionSize : imageHeight

      // Where the source image sits in the full scene.
      const srcOffsetX = direction === 'left' ? extensionSize : 0
      const srcOffsetY = direction === 'up'   ? extensionSize : 0

      // Where the extension band sits in the full scene (top-left corner).
      const extOffsetX = direction === 'right' ? imageWidth  : 0
      const extOffsetY = direction === 'down'  ? imageHeight : 0

      // Band coordinate → full-scene coordinate (band 0 aligns with scene 0 on
      // the extension side; context-at-start dirs add the source inset):
      //   down  : bandY → sceneY = (imageHeight - contextSize) + bandY
      //   up    : bandY → sceneY = bandY
      //   right : bandX → sceneX = (imageWidth - contextSize) + bandX
      //   left  : bandX → sceneX = bandX
      const bandToSceneX = (bx: number): number => {
        if (direction === 'right') return (imageWidth - contextSize) + bx
        return bx
      }
      const bandToSceneY = (by: number): number => {
        if (direction === 'down') return (imageHeight - contextSize) + by
        return by
      }

      // ── Scale to fit within maxDim ───────────────────────────────────────
      const scale = Math.min(1, maxDim / Math.max(sceneW, sceneH))
      const outW  = Math.max(1, Math.round(sceneW * scale))
      const outH  = Math.max(1, Math.round(sceneH * scale))

      const map = document.createElement('canvas')
      map.width  = outW
      map.height = outH
      const ctx = map.getContext('2d')
      if (!ctx) {
        resolve({ mapDataUrl: bandCanvas.toDataURL('image/jpeg', 0.85), mapWidth: map.width, mapHeight: map.height, tileRegionInMap: { x: 0, y: 0, width: map.width, height: map.height } })
        return
      }

      // Scaled extension-zone rectangle (used in multiple steps below).
      const extSceneW = isVertical ? imageWidth    : extensionSize
      const extSceneH = isVertical ? extensionSize : imageHeight
      const extSX = Math.round(extOffsetX * scale)
      const extSY = Math.round(extOffsetY * scale)
      const extSW = Math.max(1, Math.round(extSceneW * scale))
      const extSH = Math.max(1, Math.round(extSceneH * scale))

      // ── Step 1: draw the full source image ───────────────────────────────
      ctx.drawImage(
        srcImg, 0, 0, imageWidth, imageHeight,
        Math.round(srcOffsetX * scale),
        Math.round(srcOffsetY * scale),
        Math.max(1, Math.round(imageWidth  * scale)),
        Math.max(1, Math.round(imageHeight * scale)),
      )

      // ── Step 2: paint the ENTIRE extension zone red ──────────────────────
      // Painting the whole extension zone red at once is more reliable than
      // enumerating individual future tiles, which can leave gaps when tile
      // blank regions don't perfectly tile-cover the extension area.
      ctx.fillStyle = PLANNING_MAP_FUTURE_COLOR
      ctx.fillRect(extSX, extSY, extSW, extSH)

      // ── Step 3: restore accepted-tile regions with real pixels ───────────
      // Draw accepted tiles' blank regions back on top of the red fill.
      for (let i = 0; i < allTileSpecs.length; i++) {
        if (!acceptedMask[i]) continue
        const spec = allTileSpecs[i]
        const br   = spec.blankRegion
        if (br.width === 0 || br.height === 0) continue

        const bBandX = spec.bandX + br.x
        const bBandY = spec.bandY + br.y
        const sX = Math.round(bandToSceneX(bBandX) * scale)
        const sY = Math.round(bandToSceneY(bBandY) * scale)
        const sW = Math.max(1, Math.round(br.width  * scale))
        const sH = Math.max(1, Math.round(br.height * scale))
        ctx.drawImage(bandCanvas, bBandX, bBandY, br.width, br.height, sX, sY, sW, sH)
      }

      // ── Step 4: paint the current tile's blank region grey ───────────────
      // This is the ONLY grey area — the fill target for phase 1.
      ctx.fillStyle = EXTENSION_BLANK_COLOR
      const cur    = currentTileSpec.blankRegion
      // Record the tile blank region in map coordinates so the caller can
      // crop the planning result to just this region for phase 2.
      const tileRegionInMap = { x: 0, y: 0, width: 1, height: 1 }
      if (cur.width > 0 && cur.height > 0) {
        const bBandX = currentTileSpec.bandX + cur.x
        const bBandY = currentTileSpec.bandY + cur.y
        const sX = Math.round(bandToSceneX(bBandX) * scale)
        const sY = Math.round(bandToSceneY(bBandY) * scale)
        const sW = Math.max(1, Math.round(cur.width  * scale))
        const sH = Math.max(1, Math.round(cur.height * scale))
        ctx.fillRect(sX, sY, sW, sH)
        tileRegionInMap.x = sX
        tileRegionInMap.y = sY
        tileRegionInMap.width  = sW
        tileRegionInMap.height = sH
      }

      resolve({ mapDataUrl: map.toDataURL('image/jpeg', 0.90), mapWidth: outW, mapHeight: outH, tileRegionInMap })
    }

    srcImg.onerror = () => {
      // Fallback: return the whole band canvas rather than crashing.
      resolve({ mapDataUrl: bandCanvas.toDataURL('image/jpeg', 0.85), mapWidth: bandCanvas.width, mapHeight: bandCanvas.height, tileRegionInMap: { x: 0, y: 0, width: bandCanvas.width, height: bandCanvas.height } })
    }

    srcImg.crossOrigin = 'anonymous'
    srcImg.src = sourceImageDataUrl
  })
}

/**
 * Map-scale rectangle of the extension zone within a full-scene global plan.
 * Uses the same scene layout as buildGlobalPlanningMap.
 */
export function globalPlanExtensionRegion(
  mapWidth: number,
  mapHeight: number,
  direction: 'up' | 'down' | 'left' | 'right',
  imageWidth: number,
  imageHeight: number,
  extensionSize: number,
): PlanTileRegion {
  const isVertical = direction === 'down' || direction === 'up'
  const sceneW = isVertical ? imageWidth : imageWidth + extensionSize
  const sceneH = isVertical ? imageHeight + extensionSize : imageHeight
  const extOffsetX = direction === 'right' ? imageWidth : 0
  const extOffsetY = direction === 'down' ? imageHeight : 0
  const extSceneW = isVertical ? imageWidth : extensionSize
  const extSceneH = isVertical ? extensionSize : imageHeight
  const scaleX = mapWidth / sceneW
  const scaleY = mapHeight / sceneH
  return {
    x: Math.round(extOffsetX * scaleX),
    y: Math.round(extOffsetY * scaleY),
    width: Math.max(1, Math.round(extSceneW * scaleX)),
    height: Math.max(1, Math.round(extSceneH * scaleY)),
  }
}

/**
 * Crop the extension-only portion from a full-scene global plan result.
 * The returned image matches the extension band aspect ratio and can be
 * displayed at 100% width/height behind tile skeletons without CSS offsets.
 */
export function cropGlobalPlanExtensionView(
  globalPlanResult: string,
  mapWidth: number,
  mapHeight: number,
  direction: 'up' | 'down' | 'left' | 'right',
  imageWidth: number,
  imageHeight: number,
  extensionSize: number,
): Promise<string> {
  const region = globalPlanExtensionRegion(
    mapWidth, mapHeight, direction, imageWidth, imageHeight, extensionSize,
  )
  return cropPlanningResult(globalPlanResult, region)
}

/**
 * Crop a planning-phase result image to the sub-rectangle that corresponds to
 * the current tile's blank region.
 *
 * After phase 1 returns a filled planning image (full-scene dimensions), only
 * the portion that was the grey fill target is relevant to phase 2.  Cropping
 * to that rectangle gives the model a compact, tile-aligned composition guide
 * rather than the full annotated scene.
 */
export function cropPlanningResult(
  planningResultDataUrl: string,
  tileRegion: { x: number; y: number; width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const { x, y, width, height } = tileRegion
      const canvas = document.createElement('canvas')
      canvas.width  = Math.max(1, width)
      canvas.height = Math.max(1, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(planningResultDataUrl)
        return
      }
      ctx.drawImage(img, x, y, width, height, 0, 0, width, height)
      // PNG: plan slices are composition guides — avoid JPEG round-trip loss.
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load planning result for crop'))
    img.crossOrigin = 'anonymous'
    img.src = planningResultDataUrl
  })
}

/**
 * Build a per-pixel alpha mask for blending a tile into the running band.
 *
 * Uses a 2D separable ramp: alpha(x,y) = hRamp(x) × vRamp(y).
 * Each ramp rises from 0 at the feathered edge to 1 at featherOverlap pixels
 * in, then stays at 1.  The product means the shared corner of two feathered
 * edges approaches 0, so the existing band (where both neighbors already
 * agree) dominates — exactly what is needed for interior tiles.
 */
function buildTileFeatherMask(
  tileWidth: number,
  tileHeight: number,
  featherOverlap: TileFeatherOverlap,
): HTMLCanvasElement {
  // Canvas dimensions and the ImageData row stride MUST be integers. The tiled
  // inpaint pipeline produces fractional tile sizes (from global-plan scaling);
  // if a fractional width were used as the stride, `(y * width + x) * 4` would
  // be fractional for every row after the first, and writes to a typed array at
  // a non-integer index are silently dropped — leaving the mask transparent and
  // erasing the AI tile during the `destination-in` feather step.
  const w = Math.max(1, Math.round(tileWidth))
  const h = Math.max(1, Math.round(tileHeight))

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const imageData = ctx.createImageData(w, h)
  const d = imageData.data

  for (let y = 0; y < h; y++) {
    let vAlpha = 1
    if (featherOverlap.top    > 0) vAlpha = Math.min(vAlpha, y / featherOverlap.top)
    if (featherOverlap.bottom > 0) vAlpha = Math.min(vAlpha, (h - 1 - y) / featherOverlap.bottom)
    vAlpha = Math.max(0, Math.min(1, vAlpha))

    for (let x = 0; x < w; x++) {
      let hAlpha = 1
      if (featherOverlap.left  > 0) hAlpha = Math.min(hAlpha, x / featherOverlap.left)
      if (featherOverlap.right > 0) hAlpha = Math.min(hAlpha, (w - 1 - x) / featherOverlap.right)
      hAlpha = Math.max(0, Math.min(1, hAlpha))

      const alpha = Math.round(hAlpha * vAlpha * 255)
      const idx = (y * w + x) * 4
      d[idx] = 255; d[idx + 1] = 255; d[idx + 2] = 255; d[idx + 3] = alpha
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/** A 2D pixel offset used to manually nudge a tile's extension content before accept. */
export interface TileShimmyOffset {
  x: number
  y: number
}

/**
 * Clamp a seam-mix amount to [0, 1].
 * 0 = fully original band content; 1 = fully new AI tile.
 */
export function clampTileSeamMix(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 1
  }
  return Math.max(0, Math.min(1, amount))
}

/**
 * Default seam mix: hard cut exactly at the natural context/blank boundary
 * so original context is preserved and only the extension region takes AI
 * pixels. Auto-accept and Accept-plan use this value.
 */
export function defaultTileSeamMix(
  tileSpec: ExtensionTileSpec,
  direction: 'up' | 'down' | 'left' | 'right',
): number {
  const { tileWidth, tileHeight, blankRegion } = tileSpec
  switch (direction) {
    case 'right': {
      if (tileWidth <= 0) {
        return 1
      }
      // cutX = blankRegion.x = (1 - amount) * tileWidth
      return clampTileSeamMix(1 - blankRegion.x / tileWidth)
    }
    case 'left': {
      if (tileWidth <= 0) {
        return 1
      }
      // cutX = blank end = amount * tileWidth
      return clampTileSeamMix((blankRegion.x + blankRegion.width) / tileWidth)
    }
    case 'down': {
      if (tileHeight <= 0) {
        return 1
      }
      // cutY = blankRegion.y = (1 - amount) * tileHeight
      return clampTileSeamMix(1 - blankRegion.y / tileHeight)
    }
    case 'up': {
      if (tileHeight <= 0) {
        return 1
      }
      // cutY = blank end = amount * tileHeight
      return clampTileSeamMix((blankRegion.y + blankRegion.height) / tileHeight)
    }
  }
}

/**
 * Build the unlock alpha mask for painting AI tile pixels onto the band.
 *
 * A pixel is unlocked (AI may write) only when ALL of:
 * 1. It passes the extension-axis seam hard cut (`seamMix`)
 * 2. It lies inside `blankRegion` (context strip is always locked)
 * 3. It is not inside an accepted-neighbour overlap rect (prior wins)
 *
 * Soft feathering is intentionally not applied — hard cuts are easier to repair.
 */
function buildTileUnlockMask(
  tileWidth: number,
  tileHeight: number,
  blankRegion: TileLocalRect,
  direction: 'up' | 'down' | 'left' | 'right',
  seamMix: number,
  lockedRects: TileLocalRect[],
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(tileWidth))
  const h = Math.max(1, Math.round(tileHeight))
  const amount = clampTileSeamMix(seamMix)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return canvas
  }

  const imageData = ctx.createImageData(w, h)
  const d = imageData.data

  const cutXRight = Math.round((1 - amount) * w)
  const cutXLeft = Math.round(amount * w)
  const cutYDown = Math.round((1 - amount) * h)
  const cutYUp = Math.round(amount * h)

  const blankX0 = blankRegion.x
  const blankY0 = blankRegion.y
  const blankX1 = blankRegion.x + blankRegion.width
  const blankY1 = blankRegion.y + blankRegion.height

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let useAi = false
      if (direction === 'right') {
        useAi = x >= cutXRight
      } else if (direction === 'left') {
        useAi = x < cutXLeft
      } else if (direction === 'down') {
        useAi = y >= cutYDown
      } else {
        useAi = y < cutYUp
      }

      // Context strip outside blankRegion is always locked to the band.
      if (useAi && (x < blankX0 || x >= blankX1 || y < blankY0 || y >= blankY1)) {
        useAi = false
      }

      // Accepted-neighbour overlaps inside the blank stay with the prior tile.
      if (useAi) {
        for (let i = 0; i < lockedRects.length; i++) {
          const r = lockedRects[i]
          if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
            useAi = false
            break
          }
        }
      }

      const idx = (y * w + x) * 4
      d[idx] = 255
      d[idx + 1] = 255
      d[idx + 2] = 255
      d[idx + 3] = useAi ? 255 : 0
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/**
 * Force-paste known-good band pixels over an AI tile result: the context
 * strip outside `blankRegion`, plus any accepted-neighbour overlaps inside
 * the blank. Used after generation so the modal RESULT view matches what
 * merge will actually keep.
 */
export async function lockPasteTileKnownPixels(
  tileResultDataUrl: string,
  bandCanvas: HTMLCanvasElement,
  tileSpec: ExtensionTileSpec,
  direction: 'up' | 'down' | 'left' | 'right',
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
): Promise<string> {
  const { bandX, bandY, tileWidth, tileHeight, blankRegion } = tileSpec
  const tileImg = await loadImageElement(tileResultDataUrl)

  const canvas = document.createElement('canvas')
  canvas.width = tileWidth
  canvas.height = tileHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return tileResultDataUrl
  }

  // Start from the live band footprint (known-good context + prior tiles).
  ctx.drawImage(bandCanvas, bandX, bandY, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)

  const lockedRects = collectAcceptedNeighbourLockRects(tileSpec, allTileSpecs, tileAccepted)
  // seamMix = 1: unlock the entire blank minus neighbour locks (no seam trim).
  const mask = buildTileUnlockMask(tileWidth, tileHeight, blankRegion, direction, 1, lockedRects)

  const offscreen = document.createElement('canvas')
  offscreen.width = tileWidth
  offscreen.height = tileHeight
  const offCtx = offscreen.getContext('2d')
  if (!offCtx) {
    return tileResultDataUrl
  }

  offCtx.drawImage(tileImg, 0, 0)
  offCtx.globalCompositeOperation = 'destination-in'
  offCtx.drawImage(mask, 0, 0)
  ctx.drawImage(offscreen, 0, 0)

  return canvas.toDataURL('image/png')
}

/**
 * Build a full-tile preview from a blank-only planning slice: band context +
 * plan stretched into `blankRegion` + accepted-neighbour overlaps restored.
 * Fixes the old path that cover-scaled the blank crop onto the whole tile.
 */
export async function assembleTileFromPlanningSlice(
  bandCanvas: HTMLCanvasElement,
  tileSpec: ExtensionTileSpec,
  planningSlice: string,
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
): Promise<string> {
  const { bandX, bandY, tileWidth, tileHeight, blankRegion } = tileSpec
  const sliceImg = await loadImageElement(planningSlice)

  const canvas = document.createElement('canvas')
  canvas.width = tileWidth
  canvas.height = tileHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return planningSlice
  }

  ctx.drawImage(bandCanvas, bandX, bandY, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)

  if (blankRegion.width > 0 && blankRegion.height > 0) {
    ctx.drawImage(
      sliceImg,
      blankRegion.x, blankRegion.y, blankRegion.width, blankRegion.height,
    )
  }

  if (allTileSpecs && tileAccepted) {
    restoreAcceptedNeighbourOverlaps(ctx, bandCanvas, tileSpec, allTileSpecs, tileAccepted)
  }

  return canvas.toDataURL('image/png')
}

/**
 * Build a tile-sized canvas from `tileImg` with its blank/extension content
 * nudged by `offset`, while the preserved context pixels stay exactly where
 * they were.
 *
 * The context strip is drawn unshifted first. Then, ONLY within the
 * `blankRegion` footprint (clipped, so shifted content can never bleed into
 * the context strip), the blank region's own content is redrawn sourced from
 * `offset` pixels away — sliding the model's fill within its fixed box. Any
 * area the shift uncovers is left transparent so whatever is already in the
 * band (prior neighbour pixels, or nothing) shows through once this tile is
 * composited — same as the seam hard-cut step already relies on.
 */
function drawTileWithShimmy(
  tileImg: HTMLImageElement,
  tileWidth: number,
  tileHeight: number,
  blankRegion: { x: number; y: number; width: number; height: number },
  offset: TileShimmyOffset,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = tileWidth
  canvas.height = tileHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  // Integer-pixel draw; no range cap — callers may nudge as far as needed.
  const dx = Math.round(offset.x)
  const dy = Math.round(offset.y)

  ctx.drawImage(tileImg, 0, 0)

  if ((dx !== 0 || dy !== 0) && blankRegion.width > 0 && blankRegion.height > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(blankRegion.x, blankRegion.y, blankRegion.width, blankRegion.height)
    ctx.clip()
    ctx.clearRect(blankRegion.x, blankRegion.y, blankRegion.width, blankRegion.height)
    ctx.drawImage(
      tileImg,
      blankRegion.x, blankRegion.y, blankRegion.width, blankRegion.height,
      blankRegion.x + dx, blankRegion.y + dy, blankRegion.width, blankRegion.height,
    )
    ctx.restore()
  }

  return canvas
}

/**
 * Draw a (possibly shimmied) tile canvas onto `destCtx` at `(destX, destY)`,
 * masked by the unlock mask (seam hard cut ∩ blankRegion ∖ neighbour locks).
 * Locked pixels leave the existing band content untouched.
 */
function compositeShimmiedTileOnto(
  destCtx: CanvasRenderingContext2D,
  destX: number,
  destY: number,
  shimmiedTile: HTMLCanvasElement,
  tileWidth: number,
  tileHeight: number,
  blankRegion: TileLocalRect,
  direction: 'up' | 'down' | 'left' | 'right',
  seamMix: number,
  lockedRects: TileLocalRect[],
): void {
  const amount = clampTileSeamMix(seamMix)

  // Fully original — leave the band untouched.
  if (amount <= 0) {
    return
  }

  const mask = buildTileUnlockMask(
    tileWidth, tileHeight, blankRegion, direction, amount, lockedRects,
  )

  const offscreen = document.createElement('canvas')
  offscreen.width = tileWidth
  offscreen.height = tileHeight
  const offCtx = offscreen.getContext('2d')
  if (!offCtx) {
    throw new Error('Failed to get offscreen tile canvas context')
  }

  offCtx.drawImage(shimmiedTile, 0, 0)
  offCtx.globalCompositeOperation = 'destination-in'
  offCtx.drawImage(mask, 0, 0)

  destCtx.drawImage(offscreen, destX, destY)
}

/**
 * Composite one AI tile result into the running band canvas.
 *
 * Alignment-preserving merge:
 * - Stretch-normalize (no cover+center shift)
 * - Optional shimmy of blank content only
 * - Unlock mask: seam hard cut ∩ blankRegion ∖ accepted-neighbour overlaps
 *   so the context strip and prior tiles are force-locked from the band
 *
 * `seamMix` defaults to the natural context/blank boundary
 * (`defaultTileSeamMix`) when omitted.
 */
export async function compositeTileResult(
  bandCanvas: HTMLCanvasElement,
  tileResultDataUrl: string,
  tileSpec: ExtensionTileSpec,
  direction: 'up' | 'down' | 'left' | 'right',
  shimmyOffset: TileShimmyOffset = { x: 0, y: 0 },
  seamMix?: number,
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
): Promise<void> {
  const { bandX, bandY, tileWidth, tileHeight, blankRegion } = tileSpec
  const mix = seamMix === undefined ? defaultTileSeamMix(tileSpec, direction) : clampTileSeamMix(seamMix)

  const normalized = await normalizeTileImageToSize(tileResultDataUrl, tileWidth, tileHeight)
  const tileImg = await loadImageElement(normalized)

  const bandCtx = bandCanvas.getContext('2d')
  if (!bandCtx) {
    throw new Error('Failed to get band canvas context for composite')
  }

  const lockedRects = collectAcceptedNeighbourLockRects(tileSpec, allTileSpecs, tileAccepted)
  const shimmied = drawTileWithShimmy(tileImg, tileWidth, tileHeight, blankRegion, shimmyOffset)
  compositeShimmiedTileOnto(
    bandCtx, bandX, bandY, shimmied, tileWidth, tileHeight,
    blankRegion, direction, mix, lockedRects,
  )
}

/**
 * Preview what `compositeTileResult` would produce at a given shimmy offset
 * and seam mix, WITHOUT mutating the live band canvas.
 *
 * Clones just this tile's footprint from the live band (so the preview
 * reflects real neighbour context + lock-paste), runs the same shimmy +
 * unlock-mask compositing used by `compositeTileResult` onto that clone,
 * then returns a seam-focused crop.
 */
export async function previewCompositeTileResult(
  bandCanvas: HTMLCanvasElement,
  tileResultDataUrl: string,
  tileSpec: ExtensionTileSpec,
  direction: 'up' | 'down' | 'left' | 'right',
  shimmyOffset: TileShimmyOffset = { x: 0, y: 0 },
  seamMix?: number,
  allTileSpecs?: ExtensionTileSpec[],
  tileAccepted?: boolean[],
  marginPx = 32,
): Promise<string> {
  const { bandX, bandY, tileWidth, tileHeight, blankRegion } = tileSpec
  const mix = seamMix === undefined ? defaultTileSeamMix(tileSpec, direction) : clampTileSeamMix(seamMix)

  // Clone just this tile's footprint from the live band — this is what
  // compositeTileResult would draw onto in place, so the preview matches.
  const bandSlice = document.createElement('canvas')
  bandSlice.width = tileWidth
  bandSlice.height = tileHeight
  const sliceCtx = bandSlice.getContext('2d')
  if (!sliceCtx) {
    throw new Error('Failed to get band slice canvas context')
  }
  sliceCtx.drawImage(bandCanvas, bandX, bandY, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)

  const normalized = await normalizeTileImageToSize(tileResultDataUrl, tileWidth, tileHeight)
  const tileImg = await loadImageElement(normalized)

  const lockedRects = collectAcceptedNeighbourLockRects(tileSpec, allTileSpecs, tileAccepted)
  const shimmied = drawTileWithShimmy(tileImg, tileWidth, tileHeight, blankRegion, shimmyOffset)
  compositeShimmiedTileOnto(
    sliceCtx, 0, 0, shimmied, tileWidth, tileHeight,
    blankRegion, direction, mix, lockedRects,
  )

  // Crop to a seam-focused window: blankRegion plus a margin of context on
  // every side, clamped to the tile bounds.
  const cropX = Math.max(0, blankRegion.x - marginPx)
  const cropY = Math.max(0, blankRegion.y - marginPx)
  const cropR = Math.min(tileWidth, blankRegion.x + blankRegion.width + marginPx)
  const cropB = Math.min(tileHeight, blankRegion.y + blankRegion.height + marginPx)
  const cropW = Math.max(1, cropR - cropX)
  const cropH = Math.max(1, cropB - cropY)

  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = cropW
  cropCanvas.height = cropH
  const cropCtx = cropCanvas.getContext('2d')
  if (!cropCtx) {
    return bandSlice.toDataURL('image/png')
  }
  cropCtx.drawImage(bandSlice, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
  return cropCanvas.toDataURL('image/png')
}

/**
 * Quick check: is the tile result still mostly unfilled (gray / white)?
 * Samples the centre 20×20 pixels of the blank region.
 * Returns false if blankRegion has zero area (pure-context tile).
 */
export async function isTileResultUnfilled(
  tileResultDataUrl: string,
  tileSpec: ExtensionTileSpec,
): Promise<boolean> {
  const { blankRegion } = tileSpec
  if (blankRegion.width === 0 || blankRegion.height === 0) return false

  const img    = await loadImageElement(tileResultDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width  = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  ctx.drawImage(img, 0, 0)

  const sampleW = Math.min(20, blankRegion.width)
  const sampleH = Math.min(20, blankRegion.height)
  const sampleX = blankRegion.x + Math.floor((blankRegion.width  - sampleW) / 2)
  const sampleY = blankRegion.y + Math.floor((blankRegion.height - sampleH) / 2)

  const data = ctx.getImageData(
    Math.max(0, Math.min(sampleX, img.width  - sampleW)),
    Math.max(0, Math.min(sampleY, img.height - sampleH)),
    sampleW, sampleH,
  ).data

  let blankCount = 0
  const total    = sampleW * sampleH
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (Math.abs(r - 176) < 30 && Math.abs(g - 176) < 30 && Math.abs(b - 176) < 30) blankCount++
    else if (r > 200 && g > 200 && b > 200) blankCount++
  }
  return total > 0 && blankCount / total > 0.5
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallax mode helpers — split a long horizontal background into game-sized
// tiles for engine import (Unity, Godot, Phaser, etc.)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParallaxTile {
  dataUrl: string
  /** 1-indexed position in the strip, useful for filenames. */
  index: number
  width: number
  height: number
  /** X offset in the source image where this tile starts. */
  sourceX: number
}

/**
 * Slice a wide image into vertical tiles of `tileWidth`, full image height.
 * The last tile is the natural remaining width if the image isn't an exact
 * multiple — game engines handle non-uniform tail tiles fine and padding can
 * introduce false edges.
 */
export function splitIntoTiles(
  imageDataUrl: string,
  tileWidth: number
): Promise<ParallaxTile[]> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const tiles: ParallaxTile[] = []
      const tileHeight = img.height
      const numTiles = Math.max(1, Math.ceil(img.width / tileWidth))

      for (let i = 0; i < numTiles; i++) {
        const sourceX = i * tileWidth
        const w = Math.min(tileWidth, img.width - sourceX)
        if (w <= 0) break
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = tileHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Failed to get canvas context'))
          return
        }
        ctx.drawImage(img, sourceX, 0, w, tileHeight, 0, 0, w, tileHeight)
        tiles.push({
          dataUrl: canvas.toDataURL('image/png'),
          index: i + 1,
          width: w,
          height: tileHeight,
          sourceX,
        })
      }
      resolve(tiles)
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = imageDataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Chroma keying — turns a flat key-color background (default magenta) into
// real transparency. Used in parallax mode so the foreground / mid / far
// layers can stack over the sky layer with proper alpha. Includes a soft-
// edge falloff and despill so element borders don't show a magenta fringe.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChromaKeyOptions {
  /** Key color RGB. Default is pure magenta (255,0,255). */
  keyR?: number
  keyG?: number
  keyB?: number
  /**
   * Magenta-cast value at or above which a pixel becomes fully transparent.
   * Cast = max(0, min(r, b) - g). Range 0..255. Default 80 — comfortably
   * above the cast that natural warm/cool tones produce while still catching
   * blended-edge pixels.
   */
  castThreshold?: number
  /**
   * Width of the soft alpha falloff just below `castThreshold`. Pixels with
   * cast in `[castThreshold - castSoftness, castThreshold]` get partial
   * alpha so anti-aliased element borders feather cleanly. Default 30.
   */
  castSoftness?: number
  /**
   * How aggressively to neutralize magenta cast on every pixel that has
   * any. 0 = off (leaves a pink halo); 1 = fully subtract the cast from
   * R and B. Default 1.0 — natural images contain no real magenta, so any
   * cast is a blend artefact and should be removed.
   */
  despill?: number
  /**
   * Fraction of the despilled cast to add back into the green channel so
   * a desaturated edge pixel doesn't go dead grey. Default 0.5.
   */
  despillGreenBoost?: number
}

/**
 * Returns a new PNG data URL with the key color replaced by transparency.
 *
 * Default tuning is for pure magenta (#FF00FF) backgrounds. Instead of a
 * naive Euclidean RGB distance to the key — which treats saturated reds and
 * blues as "kinda magenta" — we use the standard chroma-key MAGENTA-CAST
 * metric: `cast = max(0, min(r, b) - g)`. This is 0 for any natural color
 * that lacks a magenta tint (greens, neutrals, deep reds, deep blues) and
 * approaches 255 for pure magenta. It cleanly separates "pixel is partially
 * blended with the magenta background" from "pixel happens to contain warm
 * red/blue tones that aren't magenta at all".
 *
 * The result:
 *   • Cast ≥ castThreshold      → fully transparent
 *   • castSoftness wide soft zone below that → smooth alpha falloff
 *   • Cast > 0                  → ALWAYS despilled (subtracts the cast from
 *                                 R and B, optionally boosts G to keep
 *                                 luminance), regardless of resulting alpha.
 *     The previous version only despilled semi-transparent pixels, which
 *     is exactly why fully-opaque-but-still-pink edge pixels showed up as
 *     a magenta halo around mountains / leaves / rocks. Despilling all
 *     pixels is safe because pure magenta never appears in natural art —
 *     any cast in the image is a blend artefact.
 */
export function chromaKeyToAlpha(
  imageDataUrl: string,
  opts: ChromaKeyOptions = {}
): Promise<string> {
  const {
    keyR = 255,
    keyG = 0,
    keyB = 255,
    castThreshold = 80,
    castSoftness = 30,
    despill = 1,
    despillGreenBoost = 0.5,
  } = opts

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, img.width, img.height)
      const data = imageData.data

      // Allow non-magenta keys to fall back to the original Euclidean
      // distance algorithm so callers who pass a custom (non-magenta)
      // key color still get a working chroma key.
      const isMagentaKey = keyR === 255 && keyG === 0 && keyB === 255

      for (let i = 0; i < data.length; i += 4) {
        let r = data[i]
        let g = data[i + 1]
        let b = data[i + 2]

        if (isMagentaKey) {
          const cast = Math.max(0, Math.min(r, b) - g)

          let alpha: number
          if (cast >= castThreshold) {
            alpha = 0
          } else if (cast <= 0) {
            alpha = 255
          } else {
            // Smooth ramp inside [max(0, castThreshold-castSoftness), castThreshold]:
            // pixels with mild cast keep most of their alpha but get partial
            // transparency so anti-aliased element borders feather cleanly
            // into the layer below.
            const softFloor = Math.max(0, castThreshold - castSoftness)
            if (cast <= softFloor) {
              alpha = 255
            } else {
              const t = (cast - softFloor) / (castThreshold - softFloor)
              alpha = Math.round(255 * (1 - t))
            }
          }
          data[i + 3] = alpha

          // Despill every pixel with any magenta cast — including the
          // fully-opaque ones the previous algorithm skipped, which were
          // the actual source of pink halos around real elements.
          if (cast > 0 && despill > 0) {
            const reduction = cast * despill
            r = Math.max(0, Math.round(r - reduction))
            b = Math.max(0, Math.round(b - reduction))
            if (despillGreenBoost > 0) {
              g = Math.min(255, Math.round(g + reduction * despillGreenBoost))
            }
            data[i] = r
            data[i + 1] = g
            data[i + 2] = b
          }
        } else {
          // Non-magenta key: legacy Euclidean distance fallback.
          const dr = r - keyR
          const dg = g - keyG
          const db = b - keyB
          const dist = Math.sqrt(dr * dr + dg * dg + db * db)
          const fallbackThreshold = 90
          const fallbackSoftness = 60
          let alpha: number
          if (dist <= fallbackThreshold) {
            alpha = 0
          } else if (dist >= fallbackThreshold + fallbackSoftness) {
            alpha = 255
          } else {
            alpha = Math.round(((dist - fallbackThreshold) / fallbackSoftness) * 255)
          }
          data[i + 3] = alpha
        }
      }
      ctx.putImageData(imageData, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = imageDataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizontal seam harmonization — kills the visible "panel banding" you get
// after chaining many AI outpaints. Each AI call introduces a tiny color /
// brightness shift; with N extends those shifts accumulate into clearly
// distinct vertical bands across a long parallax background, even though
// every individual seam was Poisson-blended at the moment of stitching.
//
// The fix: compute the per-column mean color across the image height, run
// a wide Gaussian over that 1-D profile to get a "what each column SHOULD
// look like if there were no panel drift" reference, and shift every pixel
// in column `x` by `(smoothed_mean(x) - actual_mean(x)) * strength`.
//
// This removes low-frequency horizontal DC drift while preserving every
// pixel's relative deviation from its column's mean, so clouds, shapes,
// and texture are untouched — only the underlying "tint trend" changes.
// ─────────────────────────────────────────────────────────────────────────────

export interface HarmonizeOptions {
  /**
   * Standard deviation of the smoothing Gaussian, in pixels. Larger values
   * smooth across more panels and give a more uniform result; smaller
   * values preserve more legitimate horizontal variation. Defaults to
   * `imageWidth / 8`, clamped to [120, 900].
   */
  sigmaPx?: number
  /**
   * How aggressively to apply the correction. 1.0 = match smoothed profile
   * exactly; 0.5 = halfway between original and target. Default 0.85 —
   * strong enough to kill panels, soft enough to keep natural variation.
   */
  strength?: number
  /**
   * Skip pixels that are close to this color in mean computation AND
   * correction. Used for parallax keyed layers (raw magenta-bg images) so
   * the magenta key stays uniform and only the visible elements get
   * harmonized.
   */
  ignoreKeyColor?: { r: number; g: number; b: number; threshold?: number }
  /**
   * Skip pixels with alpha below this value. Used for already-keyed images
   * (with real alpha) so transparent regions don't pollute column means
   * and don't get correction applied.
   */
  minAlpha?: number
}

function gaussianKernel1D(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + radius] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

function smooth1D(arr: Float32Array, sigma: number): Float32Array {
  const k = gaussianKernel1D(sigma)
  const radius = (k.length - 1) / 2
  const N = arr.length
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    let acc = 0
    let w = 0
    for (let j = -radius; j <= radius; j++) {
      const x = i + j
      if (x < 0 || x >= N) continue
      const kw = k[j + radius]
      acc += arr[x] * kw
      w += kw
    }
    out[i] = w > 0 ? acc / w : arr[i]
  }
  return out
}

/**
 * Equalize horizontal color drift across an image. See block comment above
 * for the algorithm. Returns a new PNG data URL; the input is unchanged.
 */
export function harmonizeHorizontalSeams(
  imageDataUrl: string,
  options: HarmonizeOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const W = img.width
      const H = img.height
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, W, H)
      const data = imageData.data

      const strength = options.strength ?? 0.85
      const sigmaPx =
        options.sigmaPx ?? Math.max(120, Math.min(900, Math.round(W / 8)))
      const minAlpha = options.minAlpha ?? 0
      const key = options.ignoreKeyColor
      const keyThreshold = key?.threshold ?? 80
      const keyThresholdSq = keyThreshold * keyThreshold

      // ── Pass 1: per-column means over participating pixels ─────────────
      const sumR = new Float32Array(W)
      const sumG = new Float32Array(W)
      const sumB = new Float32Array(W)
      const counts = new Float32Array(W)

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4
          const a = data[idx + 3]
          if (a < minAlpha) continue
          const r = data[idx]
          const g = data[idx + 1]
          const b = data[idx + 2]
          if (key) {
            const dr = r - key.r
            const dg = g - key.g
            const db = b - key.b
            if (dr * dr + dg * dg + db * db < keyThresholdSq) continue
          }
          sumR[x] += r
          sumG[x] += g
          sumB[x] += b
          counts[x] += 1
        }
      }

      const meanR = new Float32Array(W)
      const meanG = new Float32Array(W)
      const meanB = new Float32Array(W)
      // For columns with zero participating pixels (e.g. fully magenta
      // column on a keyed layer), fall back to the global mean of all
      // participating pixels so smoothing has a sensible value to use.
      let globalR = 0
      let globalG = 0
      let globalB = 0
      let globalCount = 0
      for (let x = 0; x < W; x++) {
        if (counts[x] > 0) {
          meanR[x] = sumR[x] / counts[x]
          meanG[x] = sumG[x] / counts[x]
          meanB[x] = sumB[x] / counts[x]
          globalR += sumR[x]
          globalG += sumG[x]
          globalB += sumB[x]
          globalCount += counts[x]
        }
      }
      if (globalCount === 0) {
        // No participating pixels at all — nothing to harmonize.
        resolve(imageDataUrl)
        return
      }
      const gR = globalR / globalCount
      const gG = globalG / globalCount
      const gB = globalB / globalCount
      for (let x = 0; x < W; x++) {
        if (counts[x] === 0) {
          meanR[x] = gR
          meanG[x] = gG
          meanB[x] = gB
        }
      }

      // ── Pass 2: smooth the per-column means across X ────────────────────
      const smoothR = smooth1D(meanR, sigmaPx)
      const smoothG = smooth1D(meanG, sigmaPx)
      const smoothB = smooth1D(meanB, sigmaPx)

      // ── Pass 3: shift every participating pixel toward the smoothed ────
      //          column mean. Skip key-color and low-alpha pixels so the
      //          magenta background and transparent regions stay clean.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4
          const a = data[idx + 3]
          if (a < minAlpha) continue
          const r = data[idx]
          const g = data[idx + 1]
          const b = data[idx + 2]
          if (key) {
            const dr = r - key.r
            const dg = g - key.g
            const db = b - key.b
            if (dr * dr + dg * dg + db * db < keyThresholdSq) continue
          }
          const shiftR = (smoothR[x] - meanR[x]) * strength
          const shiftG = (smoothG[x] - meanG[x]) * strength
          const shiftB = (smoothB[x] - meanB[x]) * strength
          const nr = r + shiftR
          const ng = g + shiftG
          const nb = b + shiftB
          data[idx] = nr < 0 ? 0 : nr > 255 ? 255 : nr
          data[idx + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng
          data[idx + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb
        }
      }

      ctx.putImageData(imageData, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = imageDataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Make horizontally tileable — the AI generates a beautiful continuous
// background, but the LEFT edge and the RIGHT edge of the final image were
// never asked to match each other. So when a game engine tiles this texture
// horizontally with `repeat-x`, the loop point (right edge of one tile
// meeting left edge of the next) shows a hard discontinuity that ruins the
// illusion of an infinite parallax.
//
// The professional fix has THREE stages — a single seam patch isn't enough
// for non-pixel-art content. From Julieanne Kost's classic Photoshop tile
// recipe and modern parallax pipelines:
//
//   0. Equalize horizontal tonality FIRST. If the source has directional
//      lighting (sunset dark→bright, sunrise bright→dark, vignettes, etc.)
//      then even a perfect seam join will tile as a clearly periodic
//      dark/light pattern — every loop point becomes visible as a band
//      because the eye picks up the brightness rhythm. Flattening the
//      DC drift across the image kills that rhythm so the tile looks
//      like one continuous flow when repeated.
//
//   1. Offset the image by W/2 (split into halves and swap them). The
//      original wrap-around discontinuity is now in the MIDDLE of the
//      offset image; the new "edges" of the offset image come from pixels
//      that were ADJACENT in the original, so they naturally match.
//
//   2. Heal the now-middle seam by blending each pixel in a narrow strip
//      around the seam with its mirror across the seam line. The blend
//      weight peaks at 50/50 right at the seam (so seam pixel values
//      become the average of left and right — invisible) and falls to
//      zero at the strip edges. This mixes both COLORS (handles any
//      remaining local discontinuity) and SHAPE/TEXTURE content (so
//      painterly cloud shapes ghost-fade into each other instead of
//      butting hard).
//
//   3. Offset back so the user's "x=0" content stays in place. The healed
//      strip ends up split across the loop point — exactly where it
//      needs to be to make tiling seamless.
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeTileableOptions {
  /**
   * Width in pixels of the seam-distribution strip. Wider = smoother
   * gradient near the loop, but more original content gets shifted.
   * Defaults to ~10% of the image width, clamped to [32, 800].
   */
  blendWidthPx?: number
  /**
   * Skip pixels close to this color when measuring/applying the seam
   * correction. Used for parallax keyed layers (raw magenta-bg images)
   * so the magenta key isn't tinted. Rows where either seam pixel is
   * the key color are skipped entirely.
   */
  ignoreKeyColor?: { r: number; g: number; b: number; threshold?: number }
  /**
   * Treat pixels with alpha below this value as "key" — so transparent
   * regions in already-keyed images don't get correction applied.
   */
  minAlpha?: number
  /**
   * How aggressively to flatten the horizontal tonal drift before the
   * seam fix (Stage 0). 0 = preserve original lighting (visible bands
   * if the source has a strong dark→bright gradient), 1 = fully flat
   * tonality (best tiling, but loses any directional sun/sunset look).
   * Default 0.85 — strong enough to kill periodic banding for painterly
   * skies, soft enough to keep some natural variation.
   */
  equalizeStrength?: number
}

/**
 * Returns a new PNG data URL that loops seamlessly when tiled horizontally.
 * The original is unchanged. Sky / opaque images and keyed (magenta-bg)
 * images both work — pass `ignoreKeyColor` for the latter.
 */
export async function makeHorizontallyTileable(
  imageDataUrl: string,
  options: MakeTileableOptions = {}
): Promise<string> {
  // ── Stage 0: equalize horizontal tonal drift ────────────────────────────
  // This is what makes the difference between "works for pixel art only"
  // and "works for everything". A painterly sky with directional lighting
  // tiles as visible periodic bands UNLESS the dark-to-bright gradient is
  // flattened across the whole image first. Pixel art usually has flat
  // tonality already, which is why the previous version looked fine on
  // pixel art and showed obvious banding on photo/painterly content.
  const equalizeStrength = options.equalizeStrength ?? 0.85
  const equalized =
    equalizeStrength > 0
      ? await harmonizeHorizontalSeams(imageDataUrl, {
          strength: equalizeStrength,
          // Tighter sigma than the default panel-banding fix because here
          // we want to flatten the WHOLE image's left-right drift, not
          // just smooth multi-panel artefacts. ~W/4 gives a smoothing
          // window that spans roughly half the image — enough to kill the
          // global directional gradient.
          sigmaPx: undefined,
          ignoreKeyColor: options.ignoreKeyColor,
          minAlpha: options.minAlpha,
        })
      : imageDataUrl

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const W = img.width
      const H = img.height
      if (W < 8 || H < 1) {
        resolve(equalized)
        return
      }
      const halfW = Math.floor(W / 2)
      // Default blend strip = 10% of width. Wider than a pure DC-shift
      // approach because the mirror-fade needs room to ramp the per-pixel
      // mirror weight smoothly from 0.5 (at seam) down to 0 (at edges) —
      // a wider ramp means painterly clouds get more frames to ghost-
      // fade into their counterpart, which reads as a soft transition
      // rather than a "double exposure".
      const K = Math.max(
        32,
        Math.min(800, options.blendWidthPx ?? Math.round(W * 0.1))
      )
      const seamX = W - halfW

      // ── Step 1: roll the image by halfW into a working canvas ───────────
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      // Right half of the original → left of rolled.
      ctx.drawImage(img, halfW, 0, W - halfW, H, 0, 0, W - halfW, H)
      // Left half of the original → right of rolled.
      ctx.drawImage(img, 0, 0, halfW, H, W - halfW, 0, halfW, H)

      // ── Step 2: mirror-fade across the middle seam ─────────────────────
      // For each pixel in the strip [seamX - K, seamX + K], blend its
      // value with the value of its mirror across the seam line. Blend
      // weight peaks at 0.5 right at the seam (making seam pixels equal
      // to the seam average → invisible) and falls smoothly to 0 at the
      // strip boundaries (so far-from-seam pixels are unchanged).
      const imageData = ctx.getImageData(0, 0, W, H)
      const data = imageData.data
      // Snapshot before any writes so reads always see the un-modified
      // rolled values regardless of iteration order.
      const snapshot = new Uint8ClampedArray(data)

      const smoothstep = (t: number): number => {
        const c = t < 0 ? 0 : t > 1 ? 1 : t
        return c * c * (3 - 2 * c)
      }

      const key = options.ignoreKeyColor
      const keyT = key?.threshold ?? 80
      const keyTSq = keyT * keyT
      const minAlpha = options.minAlpha ?? 0

      const isKeyPixel = (r: number, g: number, b: number, a: number) => {
        if (a < minAlpha) return true
        if (!key) return false
        const dr = r - key.r
        const dg = g - key.g
        const db = b - key.b
        return dr * dr + dg * dg + db * db < keyTSq
      }

      const stripStart = Math.max(0, seamX - K)
      const stripEnd = Math.min(W, seamX + K)

      for (let y = 0; y < H; y++) {
        for (let x = stripStart; x < stripEnd; x++) {
          const idx = (y * W + x) * 4
          const sR = snapshot[idx]
          const sG = snapshot[idx + 1]
          const sB = snapshot[idx + 2]
          const sA = snapshot[idx + 3]
          if (isKeyPixel(sR, sG, sB, sA)) continue

          const mirrorX = 2 * seamX - 1 - x
          if (mirrorX < 0 || mirrorX >= W) continue

          const mIdx = (y * W + mirrorX) * 4
          const mR = snapshot[mIdx]
          const mG = snapshot[mIdx + 1]
          const mB = snapshot[mIdx + 2]
          const mA = snapshot[mIdx + 3]
          if (isKeyPixel(mR, mG, mB, mA)) continue

          // Distance from seam, normalised to [0, 1]. Using the sub-pixel
          // offset 0.5 keeps the math symmetric across seamX so the two
          // pixels straddling the seam (seamX-1 and seamX) both land at
          // the same blend weight 0.5.
          const dist = Math.min(1, Math.abs(x - seamX + 0.5) / K)
          // Mirror weight peaks at 0.5 (at seam) and tapers to 0 (at
          // strip boundaries). Smoothstep on (1 - dist) gives a smooth
          // bell that's flat at both ends — no visible kink at the
          // strip edges.
          const alphaMirror = 0.5 * smoothstep(1 - dist)
          const alphaOrig = 1 - alphaMirror

          const r = alphaOrig * sR + alphaMirror * mR
          const g = alphaOrig * sG + alphaMirror * mG
          const b = alphaOrig * sB + alphaMirror * mB
          data[idx] = r < 0 ? 0 : r > 255 ? 255 : r
          data[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g
          data[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b
        }
      }
      ctx.putImageData(imageData, 0, 0)

      // ── Step 3: roll back so the user's original "start" stays at x=0.
      // Rolling by halfW twice = identity on indexing; the corrections we
      // applied at the rolled middle land split across positions [W-K, W-1]
      // and [0, K-1] in the final image — exactly the loop point.
      const finalCanvas = document.createElement('canvas')
      finalCanvas.width = W
      finalCanvas.height = H
      const finalCtx = finalCanvas.getContext('2d')
      if (!finalCtx) {
        reject(new Error('Failed to get final canvas context'))
        return
      }
      finalCtx.drawImage(canvas, halfW, 0, W - halfW, H, 0, 0, W - halfW, H)
      finalCtx.drawImage(canvas, 0, 0, halfW, H, W - halfW, 0, halfW, H)

      resolve(finalCanvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = equalized
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Make vertically tileable — same algorithm as `makeHorizontallyTileable`
// but applied along Y. Implementation rotates the source 90° clockwise,
// runs the horizontal pass, then rotates back. This reuses every helper
// (snapshot, smoothstep, mirror-fade, equalize) without duplication.
//
// Used by edge tiles whose only loop axis is vertical (left edge / right
// edge in a platformer auto-tile).
// ─────────────────────────────────────────────────────────────────────────────

export async function makeVerticallyTileable(
  imageDataUrl: string,
  options: MakeTileableOptions = {}
): Promise<string> {
  const rotated = await rotate90(imageDataUrl, 'cw')
  const tiled = await makeHorizontallyTileable(rotated, options)
  return rotate90(tiled, 'ccw')
}

/** Rotate a PNG data URL by 90 degrees in either direction. */
async function rotate90(
  imageDataUrl: string,
  direction: 'cw' | 'ccw'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const W = img.width
      const H = img.height
      const canvas = document.createElement('canvas')
      canvas.width = H
      canvas.height = W
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get rotation canvas context'))
        return
      }
      // Translate to the new center, rotate, then draw centered on origin.
      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.rotate(direction === 'cw' ? Math.PI / 2 : -Math.PI / 2)
      ctx.drawImage(img, -W / 2, -H / 2)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image for rotation'))
    img.src = imageDataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice an image into a uniform grid of cells. Used by the tile-set
// sprite-sheet flow: one AI call returns the full 4×4 sheet, then this
// utility cuts it into row-major cells. The source is rescaled to the
// expected sheet dimensions BEFORE slicing so the cuts always land on
// clean fractional boundaries even if the AI returned a slightly-off
// resolution (e.g. 2056×2048 instead of 2048²).
//
// Returns row-major cells: `result[row * cols + col]`.
// ─────────────────────────────────────────────────────────────────────────────

export interface SliceImageGridOptions {
  cols: number
  rows: number
  /** Final cell size in pixels. Each output PNG is exactly this size. */
  cellSize: number
}

export async function sliceImageGrid(
  imageDataUrl: string,
  options: SliceImageGridOptions
): Promise<string[]> {
  const { cols, rows, cellSize } = options
  const sheetW = cols * cellSize
  const sheetH = rows * cellSize

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      // Normalize to the expected sheet size first so slicing always lands
      // on clean cell boundaries, even when the model returns a slightly
      // different resolution.
      const sheetCanvas = document.createElement('canvas')
      sheetCanvas.width = sheetW
      sheetCanvas.height = sheetH
      const sheetCtx = sheetCanvas.getContext('2d')
      if (!sheetCtx) {
        reject(new Error('Failed to get sheet canvas context'))
        return
      }
      sheetCtx.imageSmoothingEnabled = true
      sheetCtx.imageSmoothingQuality = 'high'
      sheetCtx.drawImage(img, 0, 0, sheetW, sheetH)

      const cells: string[] = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellCanvas = document.createElement('canvas')
          cellCanvas.width = cellSize
          cellCanvas.height = cellSize
          const cellCtx = cellCanvas.getContext('2d')
          if (!cellCtx) {
            reject(new Error('Failed to get cell canvas context'))
            return
          }
          cellCtx.drawImage(
            sheetCanvas,
            c * cellSize,
            r * cellSize,
            cellSize,
            cellSize,
            0,
            0,
            cellSize,
            cellSize
          )
          cells.push(cellCanvas.toDataURL('image/png'))
        }
      }
      resolve(cells)
    }
    img.onerror = () => reject(new Error('Failed to load image for slicing'))
    img.src = imageDataUrl
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Make 2D tileable — combines the horizontal pass (`makeHorizontallyTileable`)
// with a vertical pass that fixes the top↔bottom seam the same way: roll the
// image by H/2, mirror-fade the now-middle horizontal seam between halves,
// then roll back. The end result tiles seamlessly in BOTH X and Y for engine
// tile-map use (stones, grass, brick, dirt, etc.).
//
// Skips the equalize-tonality stage 0 by default for vertical: material
// textures usually have NO directional vertical gradient (no sky-to-ground)
// so flattening would only erase legitimate variation. The horizontal pass
// still runs equalize because horizontal directional drift is common (and
// the source already wasn't tile-friendly because of it).
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeTileable2DOptions extends MakeTileableOptions {
  /**
   * Vertical seam-distribution strip height in pixels. Defaults to ~10% of
   * the image height, clamped to [32, 800].
   */
  verticalBlendHeightPx?: number
}

/**
 * Returns a new PNG data URL that loops seamlessly when tiled in BOTH X and Y.
 * The original is unchanged. Designed for opaque material textures; works on
 * keyed images too if `ignoreKeyColor` is passed.
 */
export async function makeTileable2D(
  imageDataUrl: string,
  options: MakeTileable2DOptions = {}
): Promise<string> {
  // ── Pass 1: horizontal tileability (with default tonal equalize) ───────
  const horizontallyTileable = await makeHorizontallyTileable(
    imageDataUrl,
    options
  )

  // ── Pass 2: vertical tileability ────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const W = img.width
      const H = img.height
      if (H < 8 || W < 1) {
        resolve(horizontallyTileable)
        return
      }

      const halfH = Math.floor(H / 2)
      const K = Math.max(
        32,
        Math.min(800, options.verticalBlendHeightPx ?? Math.round(H * 0.1))
      )
      const seamY = H - halfH

      // Step 1: roll the image by halfH into a working canvas.
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      // Bottom half of the source → top of rolled.
      ctx.drawImage(img, 0, halfH, W, H - halfH, 0, 0, W, H - halfH)
      // Top half of the source → bottom of rolled.
      ctx.drawImage(img, 0, 0, W, halfH, 0, H - halfH, W, halfH)

      // Step 2: mirror-fade across the now-middle horizontal seam.
      const imageData = ctx.getImageData(0, 0, W, H)
      const data = imageData.data
      const snapshot = new Uint8ClampedArray(data)

      const smoothstep = (t: number): number => {
        const c = t < 0 ? 0 : t > 1 ? 1 : t
        return c * c * (3 - 2 * c)
      }

      const key = options.ignoreKeyColor
      const keyT = key?.threshold ?? 80
      const keyTSq = keyT * keyT
      const minAlpha = options.minAlpha ?? 0

      const isKeyPixel = (r: number, g: number, b: number, a: number) => {
        if (a < minAlpha) return true
        if (!key) return false
        const dr = r - key.r
        const dg = g - key.g
        const db = b - key.b
        return dr * dr + dg * dg + db * db < keyTSq
      }

      const stripStart = Math.max(0, seamY - K)
      const stripEnd = Math.min(H, seamY + K)

      for (let y = stripStart; y < stripEnd; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4
          const sR = snapshot[idx]
          const sG = snapshot[idx + 1]
          const sB = snapshot[idx + 2]
          const sA = snapshot[idx + 3]
          if (isKeyPixel(sR, sG, sB, sA)) continue

          const mirrorY = 2 * seamY - 1 - y
          if (mirrorY < 0 || mirrorY >= H) continue

          const mIdx = (mirrorY * W + x) * 4
          const mR = snapshot[mIdx]
          const mG = snapshot[mIdx + 1]
          const mB = snapshot[mIdx + 2]
          const mA = snapshot[mIdx + 3]
          if (isKeyPixel(mR, mG, mB, mA)) continue

          const dist = Math.min(1, Math.abs(y - seamY + 0.5) / K)
          const alphaMirror = 0.5 * smoothstep(1 - dist)
          const alphaOrig = 1 - alphaMirror

          const r = alphaOrig * sR + alphaMirror * mR
          const g = alphaOrig * sG + alphaMirror * mG
          const b = alphaOrig * sB + alphaMirror * mB
          data[idx] = r < 0 ? 0 : r > 255 ? 255 : r
          data[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g
          data[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b
        }
      }
      ctx.putImageData(imageData, 0, 0)

      // Step 3: roll back so the user's "y=0" content stays at the top.
      // The healed horizontal strip lands at the top↔bottom loop point.
      const finalCanvas = document.createElement('canvas')
      finalCanvas.width = W
      finalCanvas.height = H
      const finalCtx = finalCanvas.getContext('2d')
      if (!finalCtx) {
        reject(new Error('Failed to get final canvas context'))
        return
      }
      finalCtx.drawImage(canvas, 0, halfH, W, H - halfH, 0, 0, W, H - halfH)
      finalCtx.drawImage(canvas, 0, 0, W, halfH, 0, H - halfH, W, halfH)

      resolve(finalCanvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = horizontallyTileable
  })
}

/**
 * Re-render an image at a target height while preserving its aspect ratio.
 * Used in parallax mode to normalize an uploaded starter frame to a chosen
 * game resolution height — keeps the workflow tidy when the user wants 1080,
 * 720, etc. Returns the original data URL untouched if it already matches.
 */
export function fitImageToHeight(
  imageDataUrl: string,
  targetHeight: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      if (img.height === targetHeight) {
        resolve(imageDataUrl)
        return
      }
      const scale = targetHeight / img.height
      const newWidth = Math.round(img.width * scale)
      const canvas = document.createElement('canvas')
      canvas.width = newWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, newWidth, targetHeight)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = imageDataUrl
  })
}

// ---------------------------------------------------------------------------
// Sprite-sheet frame baseline alignment
// ---------------------------------------------------------------------------
//
// Even with a structural guide image, multi-panel AI sprite generation can
// drift on the y-axis from frame to frame — the model paints the character
// 5–25 pixels higher or lower in some cells than others, producing a "feet
// bouncing" flicker when the animation is played back at speed.
//
// The fix is purely post-process: once frames have been chroma-keyed to
// transparency, we scan each frame's alpha channel from the bottom up to
// detect the actual foot pixel coordinate, then translate the frame
// vertically so every detected foot coordinate matches a shared target.
// Detection uses opacity (not magenta) because the cells are already keyed.
//
// We use the MEDIAN of all bottoms as the target so the alignment is
// robust to airborne outliers (jump apex, run mid-air recovery frames):
// those frames have a wildly higher bottom and get filtered out before
// they can poison the target. Frames that drift further than `maxShift`
// from the target are treated as intentionally airborne and left alone.

interface FrameAlignmentOptions {
  /** Alpha (0–255) above which a pixel counts as "character" content.
   *  Anti-aliased halo pixels are typically <16; we use 32 to be safe. */
  alphaThreshold?: number
  /** Minimum opaque pixels per row to accept that row as the bottom.
   *  Guards against single stray pixels from chroma-key artifacts. */
  minRowPixels?: number
  /** Max absolute vertical shift (in pixels) to apply. Frames whose
   *  detected bottom drifts more than this from the target are skipped
   *  (assumed airborne). Defaults to 20% of the cell height. Ignored when
   *  `groundAll` is true. */
  maxShift?: number
  /** When true, treat the animation as fully GROUNDED (no airborne frames):
   *  EVERY frame is planted on the shared (median) baseline regardless of how
   *  far it must move — no frame is exempted as "airborne". Use for idle /
   *  walk / attack / hurt / death. Leave false for jump / run so apex frames
   *  that drift past `maxShift` keep their lift. */
  groundAll?: boolean
  /** Explicit target baseline (y px within the cell). When provided, grounded
   *  frames are planted to this fixed ground line instead of the median of the
   *  generated bottoms. Use this when the whole generated sheet sits too high. */
  targetBaseline?: number
}

/**
 * Find the y-coordinate of the character's foot baseline: the lowest row that
 * is the bottom of a SOLID vertical run, not an isolated stray.
 *
 * Naively returning "the lowest row with ≥N opaque pixels" is fragile: a
 * single line of chroma-key halo pixels, a faint anti-aliased edge, or a thin
 * downward protrusion (a sword tip, a trailing cape) sits below the real feet
 * and poisons the baseline for that one frame — which is the main source of
 * per-frame baseline inconsistency. We instead require the detected bottom to
 * cap a run of `runRows` consecutive substantive rows, so thin artifacts are
 * ignored and we lock onto actual body mass (the foot).
 */
function findFrameBottomY(
  imageData: ImageData,
  alphaThreshold: number,
  minRowPixels: number,
  runRows: number
): number {
  const { data, width, height } = imageData
  const counts = new Array<number>(height)
  for (let y = 0; y < height; y++) {
    let c = 0
    const rowStart = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[rowStart + x * 4 + 3] > alphaThreshold) c++
    }
    counts[y] = c
  }
  // Lowest row that caps a run of `runRows` substantive rows (rejects strays).
  for (let y = height - 1; y >= 0; y--) {
    if (counts[y] < minRowPixels) continue
    let run = 0
    for (let k = 0; k < runRows && y - k >= 0; k++) {
      if (counts[y - k] >= minRowPixels) run++
      else break
    }
    if (run >= runRows) return y
  }
  // Fallback: lowest row with any content at all (very short/thin subjects).
  for (let y = height - 1; y >= 0; y--) {
    if (counts[y] >= 1) return y
  }
  return -1
}

/**
 * Translate a chroma-keyed cell vertically by `shiftY` pixels, returning
 * a fresh PNG data URL. Positive `shiftY` moves content DOWN (top rows
 * become transparent, bottom rows clip off). Negative moves UP.
 */
function shiftCellVertical(
  img: HTMLImageElement,
  shiftY: number
): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, shiftY)
  return canvas.toDataURL('image/png')
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = url
  })
}

// ---------------------------------------------------------------------------
// Uploaded-character background cleanup
// ---------------------------------------------------------------------------
//
// Users often upload an asset that LOOKS transparent but actually has a
// checkerboard (or plain/solid) background baked into the pixels — e.g. a
// screenshot of a transparent sprite from an editor. Our chroma-key only
// strips magenta, so that baked background would otherwise be treated as part
// of the art by the model.
//
// This pass removes such a background by flood-filling inward from the image
// edges, clearing pixels that look like background:
//   • the editor "transparency" checkerboard (light + de-saturated greys), or
//   • a solid backdrop matching the sampled corner color.
// Because it only removes regions CONNECTED to the border, interior light
// areas of the character (white collar, etc.) are preserved.
//
// CRITICAL: if the image already carries real transparency, we assume it's a
// clean asset and return it untouched — so this never damages proper PNGs.

interface UploadBackgroundOptions {
  /** If the fraction of already-transparent pixels exceeds this, the image is
   *  treated as a clean transparent asset and returned unchanged. */
  transparentSkipFraction?: number
  /** Max dimension to process at (keeps the flood fill cheap on huge uploads). */
  maxSize?: number
}

export async function removeUploadedBackground(
  dataUrl: string,
  opts: UploadBackgroundOptions = {}
): Promise<string> {
  const transparentSkipFraction = opts.transparentSkipFraction ?? 0.02
  const maxSize = opts.maxSize ?? 1024

  const img = await loadImageFromUrl(dataUrl)
  let w = img.width
  let h = img.height
  if (!w || !h) return dataUrl
  // Downscale only for processing if absurdly large; otherwise keep native.
  const scale = Math.min(1, maxSize / Math.max(w, h))
  w = Math.max(1, Math.round(w * scale))
  h = Math.max(1, Math.round(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData
  const n = w * h

  // Already transparent? Treat as a clean asset and leave it alone.
  let transparent = 0
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 200) transparent++
  }
  if (transparent / n > transparentSkipFraction) return dataUrl

  // Sample the four corners to characterize a possible solid backdrop.
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ].map(([x, y]) => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2]] as [number, number, number]
  })
  const avgCorner: [number, number, number] = [
    Math.round(corners.reduce((s, c) => s + c[0], 0) / corners.length),
    Math.round(corners.reduce((s, c) => s + c[1], 0) / corners.length),
    Math.round(corners.reduce((s, c) => s + c[2], 0) / corners.length),
  ]
  // Are the corners consistent enough to call it a single solid backdrop?
  const cornerSpread = Math.max(
    ...corners.map((c) =>
      Math.max(
        Math.abs(c[0] - avgCorner[0]),
        Math.abs(c[1] - avgCorner[1]),
        Math.abs(c[2] - avgCorner[2])
      )
    )
  )
  const solidBackdrop = cornerSpread < 24

  const isCheckerLike = (r: number, g: number, b: number): boolean => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    // Light and nearly grey — covers both the white and grey checker squares.
    return max > 175 && max - min < 38
  }
  const matchesCorner = (r: number, g: number, b: number): boolean => {
    if (!solidBackdrop) return false
    return (
      Math.abs(r - avgCorner[0]) +
        Math.abs(g - avgCorner[1]) +
        Math.abs(b - avgCorner[2]) <
      60
    )
  }
  const isBackground = (idx: number): boolean => {
    const i = idx * 4
    if (data[i + 3] < 16) return true
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    return isCheckerLike(r, g, b) || matchesCorner(r, g, b)
  }

  // BFS flood fill from every border pixel through background-like pixels.
  const visited = new Uint8Array(n)
  const queue: number[] = []
  const pushIf = (idx: number) => {
    if (idx < 0 || idx >= n) return
    if (visited[idx]) return
    visited[idx] = 1
    if (isBackground(idx)) queue.push(idx)
  }
  for (let x = 0; x < w; x++) {
    pushIf(x)
    pushIf((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    pushIf(y * w)
    pushIf(y * w + (w - 1))
  }
  let removed = 0
  while (queue.length) {
    const idx = queue.pop() as number
    data[idx * 4 + 3] = 0
    removed++
    const x = idx % w
    const y = (idx / w) | 0
    if (x > 0) pushIf(idx - 1)
    if (x < w - 1) pushIf(idx + 1)
    if (y > 0) pushIf(idx - w)
    if (y < h - 1) pushIf(idx + w)
  }

  // Nothing looked like background — return original to be safe.
  if (removed === 0) return dataUrl

  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Align an array of chroma-keyed sprite-cell PNGs so their detected foot
 * baselines share a common y-coordinate. Returns the aligned cells in the
 * same order, plus diagnostic info about what was detected.
 *
 * Algorithm:
 *   1. Decode each cell's alpha channel to find its bottom y.
 *   2. Compute the MEDIAN of the detected bottoms (robust to outliers).
 *   3. For each cell, compute delta = median - cellBottom.
 *      - |delta| ≤ maxShift → translate cell by delta px (alignment).
 *      - |delta|  > maxShift → leave cell alone (assumed airborne).
 *      - cellBottom = -1 → leave cell alone (empty frame).
 *
 * Input cells are expected to be the same size; mismatched sizes still
 * work but the maxShift default is computed from the first cell.
 */
export async function alignSpriteFramesToBaseline(
  cells: string[],
  opts: FrameAlignmentOptions = {}
): Promise<{
  cells: string[]
  targetBaseline: number | null
  detected: number[]
  shifted: number[]
}> {
  if (cells.length === 0) {
    return { cells, targetBaseline: null, detected: [], shifted: [] }
  }

  // Ignore faint chroma-key halo (semi-transparent edge pixels) by requiring a
  // reasonably opaque pixel, and reject thin strays via the run requirement.
  const alphaThreshold = opts.alphaThreshold ?? 64
  const minRowPixels = opts.minRowPixels ?? 4
  const groundAll = opts.groundAll ?? false

  const images = await Promise.all(cells.map((c) => loadImageFromUrl(c)))
  const cellHeight = images[0]?.height ?? 512
  const runRows = Math.max(3, Math.round(cellHeight * 0.012))

  // Extract bottoms.
  const detected: number[] = images.map((img) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height)
    return findFrameBottomY(data, alphaThreshold, minRowPixels, runRows)
  })

  // The FLOOR (ground line) the animation is planted on. Prefer the caller's
  // explicit target; otherwise fall back to the median of the detected bottoms
  // so behaviour without a target stays sensible.
  const validBottoms = detected.filter((b) => b >= 0).sort((a, b) => a - b)
  if (validBottoms.length === 0) {
    return { cells, targetBaseline: null, detected, shifted: detected.map(() => 0) }
  }
  const floor =
    typeof opts.targetBaseline === 'number'
      ? Math.max(0, Math.min(cellHeight - 1, Math.round(opts.targetBaseline)))
      : validBottoms[Math.floor(validBottoms.length / 2)]

  const aligned: string[] = []
  const shifts: number[] = []
  const clamp = (d: number) => Math.max(-cellHeight, Math.min(cellHeight, d))

  if (groundAll) {
    // GROUNDED anim (idle / walk / attack / …): every frame's OWN bottom is
    // planted on the floor line so the creature never drifts vertically — no
    // exemptions, no maxShift, no median that lets a whole high row float.
    for (let i = 0; i < cells.length; i++) {
      const bottom = detected[i]
      if (bottom < 0) {
        aligned.push(cells[i])
        shifts.push(0)
        continue
      }
      const delta = clamp(floor - bottom)
      if (Math.abs(delta) < 1) {
        aligned.push(cells[i])
        shifts.push(0)
        continue
      }
      try {
        aligned.push(shiftCellVertical(images[i], delta))
        shifts.push(delta)
      } catch {
        aligned.push(cells[i])
        shifts.push(0)
      }
    }
  } else {
    // AIRBORNE anim (jump / run / pounce / flight …): a RIGID shift. Anchor the
    // most-grounded pose (a robust high percentile of the bottoms, so one
    // stray-low frame can't skew it) to the floor, then translate EVERY frame
    // by that SAME delta. This preserves the animation's real vertical motion
    // (the lift between contact and suspension) while guaranteeing the lowest
    // pose sits on the ground and nothing floats due to a global offset.
    const gi = Math.min(
      validBottoms.length - 1,
      Math.round((validBottoms.length - 1) * 0.85)
    )
    const groundRef = validBottoms[gi]
    const delta = clamp(floor - groundRef)
    for (let i = 0; i < cells.length; i++) {
      const bottom = detected[i]
      if (bottom < 0 || Math.abs(delta) < 1) {
        aligned.push(cells[i])
        shifts.push(0)
        continue
      }
      try {
        aligned.push(shiftCellVertical(images[i], delta))
        shifts.push(delta)
      } catch {
        aligned.push(cells[i])
        shifts.push(0)
      }
    }
  }

  const targetBaseline = floor

  return {
    cells: aligned,
    targetBaseline,
    detected,
    shifted: shifts,
  }
}

// ---------------------------------------------------------------------------
// Sprite-sheet frame SCALE normalization
// ---------------------------------------------------------------------------
//
// Baseline + horizontal centering fix where a frame sits, but not how BIG the
// model drew it. The image model re-draws the character independently in every
// cell, so its overall size wobbles ±10–25% frame to frame — the silhouette
// "breathes" during playback even though the pose guide asked for one constant
// scale. Quadrupeds/serpents show it worst because their pose guide is capped
// small (to keep the long body inside one cell), leaving the model more slack.
//
// This pass measures each frame's tight silhouette, takes the MEDIAN size as
// the intended scale, and uniformly rescales each frame toward that median.
// Two safeguards keep it from flattening real animation:
//   • a tolerance band — frames already close to the target are left untouched;
//   • a clamp on the correction — no frame is scaled by more than ±maxAdjust,
//     so a genuinely extended pose (run reach, attack lunge) keeps its shape.
// We measure SIZE as the bbox diagonal √(w²+h²): when a creature flattens, its
// width grows while its height shrinks, so the diagonal stays far more
// pose-stable than either dimension alone — it tracks true size, not pose.

/** Tight alpha bounding box of a frame, ignoring chroma-key halo and single
 *  stray pixels (a row/column must hold ≥ `noiseFloorPx` opaque pixels). */
function measureAlphaBBox(
  img: HTMLImageElement,
  alphaThreshold: number,
  noiseFloorPx: number
): { minX: number; minY: number; w: number; h: number } | null {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, img.width, img.height)
  const w = img.width
  const h = img.height
  const rowCount = new Int32Array(h)
  const colCount = new Int32Array(w)
  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4
    for (let x = 0; x < w; x++) {
      if (data[rowStart + x * 4 + 3] > alphaThreshold) {
        rowCount[y]++
        colCount[x]++
      }
    }
  }
  let minX = -1
  let maxX = -1
  let minY = -1
  let maxY = -1
  for (let x = 0; x < w; x++) {
    if (colCount[x] >= noiseFloorPx) {
      if (minX < 0) minX = x
      maxX = x
    }
  }
  for (let y = 0; y < h; y++) {
    if (rowCount[y] >= noiseFloorPx) {
      if (minY < 0) minY = y
      maxY = y
    }
  }
  if (minX < 0 || minY < 0) return null
  return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

interface FrameScaleOptions {
  /** Alpha above which a pixel counts as character content. Default 64. */
  alphaThreshold?: number
  /** Min opaque pixels per row/column to count (rejects halo + strays). */
  noiseFloorPx?: number
  /** Frames whose size is within this fraction of the target are left as-is. */
  tolerance?: number
  /** Clamp each frame's scale correction to ±this fraction so real pose
   *  extension/squash is preserved. Default 0.18. */
  maxScaleAdjust?: number
}

/**
 * Normalize the on-screen SIZE of each sprite frame so the character keeps a
 * constant scale through the animation. Rescales about each frame's silhouette
 * center (subsequent baseline + horizontal passes re-seat position), returning
 * fresh cells plus diagnostics. Cells that can't be measured are passed through
 * unchanged. Run this BEFORE baseline alignment / horizontal centering.
 */
export async function normalizeSpriteFrameScale(
  cells: string[],
  opts: FrameScaleOptions = {}
): Promise<{
  cells: string[]
  targetSize: number | null
  sizes: number[]
  scales: number[]
}> {
  if (cells.length === 0) {
    return { cells, targetSize: null, sizes: [], scales: [] }
  }
  const alphaThreshold = opts.alphaThreshold ?? 64
  const noiseFloorPx = opts.noiseFloorPx ?? 3
  const tolerance = opts.tolerance ?? 0.05
  const maxScaleAdjust = opts.maxScaleAdjust ?? 0.18

  const images = await Promise.all(cells.map((c) => loadImageFromUrl(c)))
  const boxes = images.map((img) =>
    measureAlphaBBox(img, alphaThreshold, noiseFloorPx)
  )
  // Pose-stable size metric: bbox diagonal.
  const sizes = boxes.map((b) => (b ? Math.hypot(b.w, b.h) : -1))
  const valid = sizes.filter((s) => s > 0).sort((a, b) => a - b)
  if (valid.length === 0) {
    return { cells, targetSize: null, sizes, scales: sizes.map(() => 1) }
  }
  const targetSize = valid[Math.floor(valid.length / 2)] // median

  const out: string[] = []
  const scales: number[] = []
  for (let i = 0; i < cells.length; i++) {
    const box = boxes[i]
    const size = sizes[i]
    if (!box || size <= 0) {
      out.push(cells[i])
      scales.push(1)
      continue
    }
    let factor = targetSize / size
    factor = Math.max(1 - maxScaleAdjust, Math.min(1 + maxScaleAdjust, factor))
    if (Math.abs(factor - 1) < tolerance) {
      out.push(cells[i])
      scales.push(1)
      continue
    }
    try {
      const img = images[i]
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        out.push(cells[i])
        scales.push(1)
        continue
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      // Scale about the silhouette center so it doesn't fly out of the cell;
      // baseline + horizontal passes re-anchor the exact position afterwards.
      const pivotX = box.minX + box.w / 2
      const pivotY = box.minY + box.h / 2
      ctx.translate(pivotX, pivotY)
      ctx.scale(factor, factor)
      ctx.translate(-pivotX, -pivotY)
      ctx.drawImage(img, 0, 0)
      out.push(canvas.toDataURL('image/png'))
      scales.push(factor)
    } catch {
      out.push(cells[i])
      scales.push(1)
    }
  }

  return { cells: out, targetSize, sizes, scales }
}

// ---------------------------------------------------------------------------
// Sprite-sheet frame-border cleanup
// ---------------------------------------------------------------------------
//
// The model sometimes paints faint cell-divider lines on the sheet (a thin
// dark rectangle around each cell) even though the prompt forbids it. Those
// lines aren't magenta, so chroma-keying leaves them in place and every sliced
// frame ends up with a dark square border around it.
//
// This pass erases that border: for each of the 4 edges it scans a thin band
// inward and clears any row/column that is "border-like" — i.e. opaque across
// most of the edge's length. A real character never forms a near-full-width
// opaque line right at a cell edge (it's centered with margin), so this only
// catches divider lines, not the character.

interface BorderCleanupOptions {
  /** Fraction of an edge's length that must be opaque for the row/col to be
   *  treated as a border line. High enough that character limbs/feet never
   *  trip it. Default 0.7. */
  coverage?: number
  /** How far inward to look for border lines, as a fraction of cell size.
   *  Default 0.03 (≈15px on a 512 cell) to also catch borders inset a few px. */
  bandFraction?: number
  /** Alpha above which a pixel counts as opaque. Default 24 (catches even
   *  semi-transparent divider lines). */
  alphaThreshold?: number
}

/**
 * Erase full-span border lines from the edges of a single chroma-keyed cell.
 * Returns a fresh PNG data URL (unchanged if no border is detected).
 */
export async function removeFrameBorder(
  cellDataUrl: string,
  opts: BorderCleanupOptions = {}
): Promise<string> {
  const coverage = opts.coverage ?? 0.7
  const bandFraction = opts.bandFraction ?? 0.03
  const alphaThreshold = opts.alphaThreshold ?? 24

  const img = await loadImageFromUrl(cellDataUrl)
  const w = img.width
  const h = img.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return cellDataUrl
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData

  const band = Math.max(2, Math.round(Math.min(w, h) * bandFraction))
  const rowNeed = Math.round(w * coverage)
  const colNeed = Math.round(h * coverage)
  let changed = false

  const rowOpaque = (y: number): number => {
    let c = 0
    const rs = y * w * 4
    for (let x = 0; x < w; x++) if (data[rs + x * 4 + 3] > alphaThreshold) c++
    return c
  }
  const colOpaque = (x: number): number => {
    let c = 0
    for (let y = 0; y < h; y++) if (data[(y * w + x) * 4 + 3] > alphaThreshold) c++
    return c
  }
  const clearRow = (y: number) => {
    const rs = y * w * 4
    for (let x = 0; x < w; x++) data[rs + x * 4 + 3] = 0
  }
  const clearCol = (x: number) => {
    for (let y = 0; y < h; y++) data[(y * w + x) * 4 + 3] = 0
  }

  for (let k = 0; k < band; k++) {
    if (rowOpaque(k) >= rowNeed) {
      clearRow(k)
      changed = true
    }
    if (rowOpaque(h - 1 - k) >= rowNeed) {
      clearRow(h - 1 - k)
      changed = true
    }
    if (colOpaque(k) >= colNeed) {
      clearCol(k)
      changed = true
    }
    if (colOpaque(w - 1 - k) >= colNeed) {
      clearCol(w - 1 - k)
      changed = true
    }
  }

  if (!changed) return cellDataUrl
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

// ---------------------------------------------------------------------------
// Sprite-frame connected-component cleanup
// ---------------------------------------------------------------------------
//
// Some image models ignore the hidden 4×2 grid and paint a second creature
// inside a single sliced cell (often vertically: one full wolf plus the cropped
// top/bottom of another wolf). Prompting + QA can reduce this, but a
// deterministic cleanup is more reliable: after chroma-keying, find connected
// opaque alpha components and keep only the main creature component.

interface PrimaryComponentOptions {
  /** Alpha above which a pixel counts as sprite content. Default 32. */
  alphaThreshold?: number
  /** Components smaller than this fraction of the cell are ignored as noise.
   *  Default 0.005 (≈1300px on a 512 cell). */
  minComponentFraction?: number
  /** Enable morphological splitting of a SINGLE connected blob that is really
   *  two creatures joined by a thin bridge. Safe for compact bodies
   *  (quadruped/blob); leave OFF for thin subjects (serpent/eel/winged flyer)
   *  where erosion could fragment one legitimate creature. Default false. */
  enableSplit?: boolean
}

interface SpriteComponent {
  id: number
  count: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  sumX: number
  sumY: number
}

/** Binary morphological erosion (4-neighbour), `iterations` passes. A pixel
 *  survives only if all 4 orthogonal neighbours are also foreground, so thin
 *  bridges ≤ 2·iterations px wide are severed while solid masses persist. */
function erodeMask(
  mask: Uint8Array,
  w: number,
  h: number,
  iterations: number
): Uint8Array {
  let cur = mask
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!cur[i]) continue
        if (
          x > 0 &&
          x < w - 1 &&
          y > 0 &&
          y < h - 1 &&
          cur[i - 1] &&
          cur[i + 1] &&
          cur[i - w] &&
          cur[i + w]
        ) {
          next[i] = 1
        }
      }
    }
    cur = next
  }
  return cur
}

/** Binary morphological dilation (4-neighbour), `iterations` passes. */
function dilateMask(
  mask: Uint8Array,
  w: number,
  h: number,
  iterations: number
): Uint8Array {
  let cur = mask
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(cur.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (cur[i]) {
          next[i] = 1
          continue
        }
        if (
          (x > 0 && cur[i - 1]) ||
          (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) ||
          (y < h - 1 && cur[i + w])
        ) {
          next[i] = 1
        }
      }
    }
    cur = next
  }
  return cur
}

/** Label 4-connected components of a binary mask. Returns the label buffer
 *  (-1 = background) and a per-label centroid/count summary. */
function labelMaskComponents(
  mask: Uint8Array,
  w: number,
  h: number
): { labels: Int32Array; comps: { id: number; count: number; sumX: number; sumY: number }[] } {
  const labels = new Int32Array(w * h).fill(-1)
  const comps: { id: number; count: number; sumX: number; sumY: number }[] = []
  const stack: number[] = []
  for (let p = 0; p < w * h; p++) {
    if (labels[p] !== -1 || !mask[p]) continue
    const id = comps.length
    const comp = { id, count: 0, sumX: 0, sumY: 0 }
    labels[p] = id
    stack.length = 0
    stack.push(p)
    while (stack.length) {
      const cur = stack.pop() as number
      const x = cur % w
      const y = (cur / w) | 0
      comp.count++
      comp.sumX += x
      comp.sumY += y
      const nb = [
        x > 0 ? cur - 1 : -1,
        x < w - 1 ? cur + 1 : -1,
        y > 0 ? cur - w : -1,
        y < h - 1 ? cur + w : -1,
      ]
      for (const n of nb) {
        if (n < 0 || labels[n] !== -1 || !mask[n]) continue
        labels[n] = id
        stack.push(n)
      }
    }
    comps.push(comp)
  }
  return { labels, comps }
}

/**
 * Keep only the primary connected alpha component in a sprite cell.
 *
 * The selected component is normally the largest; a small centre bonus helps
 * choose the intended centered creature when a cropped spillover component is
 * still fairly large. Returns the original data URL if there is only one real
 * component.
 */
export async function isolatePrimarySpriteComponent(
  cellDataUrl: string,
  opts: PrimaryComponentOptions = {}
): Promise<string> {
  const alphaThreshold = opts.alphaThreshold ?? 32
  const minComponentFraction = opts.minComponentFraction ?? 0.005
  const enableSplit = opts.enableSplit ?? false

  const img = await loadImageFromUrl(cellDataUrl)
  const w = img.width
  const h = img.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return cellDataUrl
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData

  const labels = new Int32Array(w * h)
  labels.fill(-1)
  const components: SpriteComponent[] = []
  const minPixels = Math.max(24, Math.round(w * h * minComponentFraction))
  const stack: number[] = []

  for (let p = 0; p < w * h; p++) {
    if (labels[p] !== -1 || data[p * 4 + 3] <= alphaThreshold) continue

    const id = components.length
    const comp: SpriteComponent = {
      id,
      count: 0,
      minX: w,
      minY: h,
      maxX: -1,
      maxY: -1,
      sumX: 0,
      sumY: 0,
    }
    labels[p] = id
    stack.length = 0
    stack.push(p)

    while (stack.length) {
      const cur = stack.pop() as number
      const x = cur % w
      const y = Math.floor(cur / w)
      comp.count++
      comp.sumX += x
      comp.sumY += y
      if (x < comp.minX) comp.minX = x
      if (x > comp.maxX) comp.maxX = x
      if (y < comp.minY) comp.minY = y
      if (y > comp.maxY) comp.maxY = y

      const neighbours = [
        x > 0 ? cur - 1 : -1,
        x < w - 1 ? cur + 1 : -1,
        y > 0 ? cur - w : -1,
        y < h - 1 ? cur + w : -1,
      ]
      for (const n of neighbours) {
        if (n < 0 || labels[n] !== -1 || data[n * 4 + 3] <= alphaThreshold) {
          continue
        }
        labels[n] = id
        stack.push(n)
      }
    }

    components.push(comp)
  }

  const real = components.filter((c) => c.count >= minPixels)
  if (real.length === 0) return cellDataUrl

  const centerX = w / 2
  const centerY = h / 2
  const scoreOf = (count: number, cx: number, cy: number) => {
    const dist = Math.hypot((cx - centerX) / w, (cy - centerY) / h)
    return count * (1 + Math.max(0, 0.35 - dist))
  }

  // CASE A — multiple disconnected components: keep the dominant central one,
  // erase the rest (a separate spillover/duplicate creature).
  if (real.length >= 2) {
    const keep = real
      .map((c) => ({
        component: c,
        score: scoreOf(c.count, c.sumX / c.count, c.sumY / c.count),
      }))
      .sort((a, b) => b.score - a.score)[0].component
    let changed = false
    for (let p = 0; p < w * h; p++) {
      const label = labels[p]
      if (label !== -1 && label !== keep.id) {
        data[p * 4 + 3] = 0
        changed = true
      }
    }
    if (!changed) return cellDataUrl
    ctx.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  }

  // CASE B — a SINGLE component. Usually that's just the creature, but two
  // creatures joined by a thin bridge (a leg/halo touching spillover from a
  // neighbouring cell) also read as one blob. Morphological OPENING tells the
  // difference: erode to sever thin bridges, then see if the blob splits into
  // ≥2 substantial cores. If it does, keep the dominant core's region; if it
  // stays one piece (a normal creature, or a thin-bodied snake/eel), bail out
  // untouched so we never fragment a legitimate single subject.
  if (!enableSplit) return cellDataUrl
  const only = real[0]
  const mask = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    if (labels[p] === only.id) mask[p] = 1
  }
  const radius = Math.max(2, Math.round(Math.min(w, h) * 0.01)) // ~5px on 512
  const eroded = erodeMask(mask, w, h, radius)
  const { labels: eLabels, comps: eComps } = labelMaskComponents(eroded, w, h)
  // A core must be a meaningful chunk of the blob to count as a separate body.
  const coreMin = Math.max(minPixels * 0.5, only.count * 0.12)
  const cores = eComps.filter((c) => c.count >= coreMin)
  if (cores.length < 2) return cellDataUrl // single subject — leave it alone

  const dominant = cores
    .map((c) => ({
      core: c,
      score: scoreOf(c.count, c.sumX / c.count, c.sumY / c.count),
    }))
    .sort((a, b) => b.score - a.score)[0].core

  // Grow the chosen core back to (roughly) its original silhouette and clip to
  // the real alpha, so the kept creature is whole but the other body — a
  // different eroded core that we don't dilate — stays erased.
  const coreMask = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    if (eLabels[p] === dominant.id) coreMask[p] = 1
  }
  const keepMask = dilateMask(coreMask, w, h, radius + 1)

  let changed = false
  for (let p = 0; p < w * h; p++) {
    if (mask[p] && !keepMask[p]) {
      data[p * 4 + 3] = 0
      changed = true
    }
  }
  if (!changed) return cellDataUrl
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

// ---------------------------------------------------------------------------
// Sprite-sheet horizontal centering
// ---------------------------------------------------------------------------
//
// Companion to the baseline (vertical) pass. The model sometimes paints the
// character offset to one side of a cell, or lets it slide left/right across
// frames so an "in place" walk/run looks like it's drifting. This pass scans
// each chroma-keyed cell, finds the character's horizontal CENTER OF MASS
// (centroid of opaque pixels — robust against a thin protrusion like a drawn
// sword or a swinging arm, which a bounding-box midpoint would over-weight),
// then translates the cell horizontally so that center lands on a shared
// target. The default target is the exact cell center, which both centers the
// character and pins it "in place" frame-to-frame.

interface FrameCenterOptions {
  /** Alpha (0–255) above which a pixel counts as character content. */
  alphaThreshold?: number
  /** Minimum opaque pixels required to trust the centroid (skips empty cells). */
  minPixels?: number
  /** 'cellCenter' (default) centers each frame's mass at width/2. 'shared'
   *  instead aligns every frame to the MEDIAN centroid — removes drift between
   *  frames without forcing dead-center, useful if the art is intentionally
   *  off-center but should stay put. */
  mode?: 'cellCenter' | 'shared'
  /** Max absolute horizontal shift (px). Guards against a bad detection
   *  shoving a frame off-screen. Defaults to 40% of the cell width. */
  maxShift?: number
}

/** Horizontal center of mass of opaque pixels; -1 if too few pixels. */
function findFrameCentroidX(
  imageData: ImageData,
  alphaThreshold: number,
  minPixels: number
): number {
  const { data, width, height } = imageData
  let sumX = 0
  let count = 0
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[rowStart + x * 4 + 3] > alphaThreshold) {
        sumX += x
        count++
      }
    }
  }
  if (count < minPixels) return -1
  return sumX / count
}

/** Translate a cell horizontally by `shiftX` px (positive = right). */
function shiftCellHorizontal(img: HTMLImageElement, shiftX: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, shiftX, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Center an array of chroma-keyed sprite cells horizontally so each
 * character's center of mass lands on a shared target (the cell center by
 * default). Returns the centered cells in order plus diagnostics.
 */
export async function centerSpriteFramesHorizontally(
  cells: string[],
  opts: FrameCenterOptions = {}
): Promise<{
  cells: string[]
  targetCenterX: number | null
  detected: number[]
  shifted: number[]
}> {
  if (cells.length === 0) {
    return { cells, targetCenterX: null, detected: [], shifted: [] }
  }

  const alphaThreshold = opts.alphaThreshold ?? 32
  const minPixels = opts.minPixels ?? 24
  const mode = opts.mode ?? 'cellCenter'

  const images = await Promise.all(cells.map((c) => loadImageFromUrl(c)))
  const cellWidth = images[0]?.width ?? 512
  const maxShift = opts.maxShift ?? Math.floor(cellWidth * 0.4)

  const detected: number[] = images.map((img) => {
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height)
    return findFrameCentroidX(data, alphaThreshold, minPixels)
  })

  const validCenters = detected.filter((c) => c >= 0).sort((a, b) => a - b)
  if (validCenters.length === 0) {
    return {
      cells,
      targetCenterX: null,
      detected,
      shifted: detected.map(() => 0),
    }
  }

  const targetCenterX =
    mode === 'shared'
      ? validCenters[Math.floor(validCenters.length / 2)]
      : cellWidth / 2

  const centered: string[] = []
  const shifts: number[] = []
  for (let i = 0; i < cells.length; i++) {
    const cx = detected[i]
    if (cx < 0) {
      centered.push(cells[i])
      shifts.push(0)
      continue
    }
    let delta = Math.round(targetCenterX - cx)
    if (Math.abs(delta) > maxShift) {
      delta = Math.sign(delta) * maxShift
    }
    if (Math.abs(delta) < 1) {
      centered.push(cells[i])
      shifts.push(0)
      continue
    }
    try {
      centered.push(shiftCellHorizontal(images[i], delta))
      shifts.push(delta)
    } catch {
      centered.push(cells[i])
      shifts.push(0)
    }
  }

  return { cells: centered, targetCenterX, detected, shifted: shifts }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiled Inpaint Pipeline — image processor utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plan a 2-D tile grid that covers the context perimeter bounding rect.
 *
 * Both axes are split symmetrically with `planTilingAxis` so every tile fits
 * within `maxDimension`. Adjacent tiles overlap by `overlapPx` so the feather
 * compositor produces seamless joins. Tiles are in scan order (left→right,
 * top→bottom) matching the processing loop in EditStudio.
 *
 * Each tile carries a `maskSubRect` — the intersection of the user's edit
 * mask with the tile in tile-local coordinates. When `maskSubRect` is null
 * the tile is pure context and the API call should be skipped.
 */
export function planInpaintTiles(
  contextW: number,
  contextH: number,
  /** Selection rect in context-perimeter coordinates (origin = contextRect top-left). */
  maskRect: { x: number; y: number; w: number; h: number },
  maxDimension: number = 1536,
  overlapPx: number = 384,
): InpaintTilePlan {
  const colPlan = planTilingAxis(contextW, maxDimension, overlapPx)
  const rowPlan = planTilingAxis(contextH, maxDimension, overlapPx)

  const tiles: InpaintTileSpec[] = []

  for (let row = 0; row < rowPlan.count; row++) {
    for (let col = 0; col < colPlan.count; col++) {
      const x = colPlan.positions[col]
      const y = rowPlan.positions[row]
      const w = colPlan.sizes[col]
      const h = rowPlan.sizes[row]

      // Feather edges that face already-processed neighbors (scan order: top then left).
      const featherOverlap = {
        top: row > 0 ? overlapPx : 0,
        left: col > 0 ? overlapPx : 0,
        bottom: 0,
        right: 0,
      }

      // Intersect the mask with this tile's bounds in context-perimeter coords.
      const iX1 = Math.max(maskRect.x, x)
      const iY1 = Math.max(maskRect.y, y)
      const iX2 = Math.min(maskRect.x + maskRect.w, x + w)
      const iY2 = Math.min(maskRect.y + maskRect.h, y + h)

      // Convert intersection to tile-local coordinates.
      const maskSubRect: InpaintTileSpec['maskSubRect'] =
        iX2 > iX1 && iY2 > iY1
          ? { x: iX1 - x, y: iY1 - y, w: iX2 - iX1, h: iY2 - iY1 }
          : null

      tiles.push({
        row, col,
        totalRows: rowPlan.count, totalCols: colPlan.count,
        x, y, w, h,
        featherOverlap,
        maskSubRect,
      })
    }
  }

  return { tiles, contextW, contextH }
}

/**
 * Crop the context perimeter from the source image and scale it so its longest
 * edge is at most `maxDim` pixels. Returns the data URL and the scale factor
 * (context-pixel → low-res-pixel) used.
 *
 * This low-res crop is the shared input for mask generation (step 3 of the
 * workflow) and the Phase 1 global plan (step 5).
 */
export async function buildLowResContextCrop(
  sourceImageUrl: string,
  contextRect: { x: number; y: number; w: number; h: number },
  maxDim: number = 1024,
): Promise<{ dataUrl: string; scale: number }> {
  const img = await loadImageElement(sourceImageUrl)
  const scale = Math.min(1, maxDim / Math.max(contextRect.w, contextRect.h))
  const outW = Math.max(1, Math.round(contextRect.w * scale))
  const outH = Math.max(1, Math.round(contextRect.h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.drawImage(img, contextRect.x, contextRect.y, contextRect.w, contextRect.h, 0, 0, outW, outH)
  }
  // PNG is lossless — no per-channel drift that would pollute the pixel diff
  // later when comparing this crop against the global plan result.
  return { dataUrl: canvas.toDataURL('image/png'), scale }
}


/**
 * Compute a pixel-level change mask by diffing two images at the same
 * resolution (original low-res context crop vs. the global plan result).
 *
 * Returns a canvas where:
 *   - Changed pixels  → fully opaque   (RGBA [255, 255, 255, 255])
 *   - Unchanged pixels → fully transparent (RGBA [0, 0, 0, 0])
 *
 * This mask is used by buildGlobalInpaintComposite to decide, for each pixel
 * inside the selection, whether to show the softened plan (changed) or the
 * crisp source (unchanged). The result replaces the LLM mask-extraction call.
 *
 * @param threshold  Per-channel maximum difference considered "same".
 *                   Default 10 absorbs JPEG compression noise in the plan
 *                   result without masking real edits.
 */
export async function computeChangeMask(
  originalUrl: string,
  planUrl: string,
  threshold = 10,
): Promise<HTMLCanvasElement> {
  const [origImg, planImg] = await Promise.all([
    loadImageElement(originalUrl),
    loadImageElement(planUrl),
  ])

  const w = origImg.naturalWidth
  const h = origImg.naturalHeight

  const origCanvas = document.createElement('canvas')
  origCanvas.width = w
  origCanvas.height = h
  const origCtx = origCanvas.getContext('2d')

  // Draw the plan scaled to match the original dimensions in case the LLM
  // returned a slightly different size.
  const planCanvas = document.createElement('canvas')
  planCanvas.width = w
  planCanvas.height = h
  const planCtx = planCanvas.getContext('2d')

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = w
  maskCanvas.height = h
  const maskCtx = maskCanvas.getContext('2d')

  if (!origCtx || !planCtx || !maskCtx) {
    // Fallback: treat everything as changed so no pixels are silently skipped.
    if (maskCtx) {
      maskCtx.fillStyle = 'white'
      maskCtx.fillRect(0, 0, w, h)
    }
    return maskCanvas
  }

  origCtx.drawImage(origImg, 0, 0, w, h)
  planCtx.drawImage(planImg, 0, 0, w, h)

  const origData = origCtx.getImageData(0, 0, w, h).data
  const planData = planCtx.getImageData(0, 0, w, h).data

  const maskImageData = maskCtx.createImageData(w, h)
  const maskData = maskImageData.data

  for (let i = 0; i < w * h; i++) {
    const idx = i * 4
    const dr = Math.abs(origData[idx]     - planData[idx])
    const dg = Math.abs(origData[idx + 1] - planData[idx + 1])
    const db = Math.abs(origData[idx + 2] - planData[idx + 2])
    const changed = Math.max(dr, dg, db) > threshold ? 255 : 0
    maskData[idx]     = changed
    maskData[idx + 1] = changed
    maskData[idx + 2] = changed
    maskData[idx + 3] = changed  // alpha: opaque = changed, transparent = unchanged
  }

  maskCtx.putImageData(maskImageData, 0, 0)
  return maskCanvas
}

/**
 * Build two display-only visualisations of the computed change mask:
 *
 *   maskUrl     — B&W PNG: white where changed, black where unchanged.
 *   overlayUrl  — global plan image with a light-blue highlight painted over
 *                 the changed regions (opacity ~45 %).
 *
 * Neither URL is ever sent to the API. They are stored in InpaintState so
 * the sidebar and tile grid can show the user where the plan made changes.
 *
 * @param maskCanvas   The canvas returned by computeChangeMask (alpha-encoded).
 * @param planUrl      The global plan result data URL (used as the base layer
 *                     in the overlay visualisation).
 */
export async function buildChangeMaskVisuals(
  maskCanvas: HTMLCanvasElement,
  planUrl: string,
): Promise<{ maskUrl: string; overlayUrl: string }> {
  const w = maskCanvas.width
  const h = maskCanvas.height

  // ── B&W mask ────────────────────────────────────────────────────────────────
  // Black background + white where the mask alpha is opaque (= changed).
  const bwCanvas = document.createElement('canvas')
  bwCanvas.width = w
  bwCanvas.height = h
  const bwCtx = bwCanvas.getContext('2d')
  if (bwCtx) {
    bwCtx.fillStyle = '#000000'
    bwCtx.fillRect(0, 0, w, h)
    bwCtx.drawImage(maskCanvas, 0, 0)
  }
  const maskUrl = bwCanvas.toDataURL('image/png')

  // ── Blue-highlight overlay ───────────────────────────────────────────────
  // Draw the plan, then paint a light-blue tint only over changed pixels.
  const planImg = await loadImageElement(planUrl)
  const overlayCanvas = document.createElement('canvas')
  overlayCanvas.width = w
  overlayCanvas.height = h
  const overlayCtx = overlayCanvas.getContext('2d')
  if (overlayCtx) {
    // Base: plan image scaled to mask dimensions (plan may differ slightly in
    // size when the LLM returns a non-exact dimension).
    overlayCtx.drawImage(planImg, 0, 0, w, h)

    // Tint layer: blue rectangle masked by the change mask.
    const tintCanvas = document.createElement('canvas')
    tintCanvas.width = w
    tintCanvas.height = h
    const tintCtx = tintCanvas.getContext('2d')
    if (tintCtx) {
      tintCtx.fillStyle = '#1e8cff'
      tintCtx.fillRect(0, 0, w, h)
      tintCtx.globalCompositeOperation = 'destination-in'
      tintCtx.drawImage(maskCanvas, 0, 0)
    }

    overlayCtx.globalAlpha = 0.45
    overlayCtx.drawImage(tintCanvas, 0, 0)
    overlayCtx.globalAlpha = 1
  }
  const overlayUrl = overlayCanvas.toDataURL('image/png')

  return { maskUrl, overlayUrl }
}


/**
 * Build the shared full-resolution composite for the tiled inpaint pass.
 *
 *   1. Base layer: crisp source pixels for the ENTIRE context region.
 *   2. Plan layer: the global plan image upscaled to full context resolution,
 *      with an adaptive blur applied — the blur radius scales with how much
 *      upscaling is actually happening (mirrors `drawSoftenedPlanningGuide`
 *      in the extend pipeline), so a plan crop close to native resolution
 *      gets little/no extra softening while a heavily-upscaled low-res plan
 *      gets enough to hide blocky resampling artifacts.
 *   3. Feathered mask: the raw pixel-diff change mask is blurred before use
 *      so the plan layer fades in/out smoothly across the diff boundary
 *      instead of a hard, jagged cut — and so the transition band straddles
 *      rather than sits exactly on the boundary.
 *   4. The masked, softened plan layer is composited over the crisp base —
 *      pixels the plan left unchanged keep their crisp source values.
 *
 * Deliberately NOT clipped to the user's selection rectangle: the change
 * mask (step 3) is the sole authority on what shows plan content. If the
 * model legitimately changed a few pixels just outside the drawn selection
 * (e.g. a shadow or highlight blending into the context band), those pixels
 * are allowed through rather than forced back to crisp source. Tiles that
 * have no overlap with the selection at all are still skipped upstream by
 * `planInpaintTiles`/`generateTile`, so this only affects bleed near the
 * selection boundary, not the whole context ring.
 *
 * Building this ONCE at full context resolution (rather than independently
 * per tile) guarantees every tile crops identical shared pixels in overlap
 * regions, eliminating a source of tile-to-tile seam mismatch. It also lets
 * `cropInpaintTileInput` reduce tile-input construction to a plain crop —
 * mirroring `buildTileInput` in the extend pipeline, which crops directly
 * from the shared running band canvas.
 */
export async function buildGlobalInpaintComposite(
  sourceImageUrl: string,
  contextRect: { x: number; y: number; w: number; h: number },
  planImageUrl: string,
  /** Context-pixel → plan-pixel scale factor from buildGlobalPlanInput. */
  globalPlanScale: number,
  /** Per-pixel diff mask from computeChangeMask. Changed pixels are opaque;
   *  unchanged pixels are transparent. Null skips the plan layer entirely
   *  (composite is pure crisp source). */
  changeMask: HTMLCanvasElement | null,
): Promise<HTMLCanvasElement> {
  const [sourceImg, planImg] = await Promise.all([
    loadImageElement(sourceImageUrl),
    loadImageElement(planImageUrl),
  ])

  const w = contextRect.w
  const h = contextRect.h

  const composite = document.createElement('canvas')
  composite.width = w
  composite.height = h
  const cctx = composite.getContext('2d')
  if (!cctx) return composite

  // Step 1: crisp source base for the entire context region.
  cctx.drawImage(sourceImg, contextRect.x, contextRect.y, w, h, 0, 0, w, h)

  if (!changeMask) return composite

  const planLayer = document.createElement('canvas')
  planLayer.width = w
  planLayer.height = h
  const pctx = planLayer.getContext('2d')
  if (!pctx) return composite

  // Step 2: plan layer upscaled to full context resolution, with adaptive
  // blur proportional to the upscale factor (context-pixel / plan-pixel).
  const upscale = globalPlanScale > 0 ? 1 / globalPlanScale : 1
  const blurPx = upscale > 1.25
    ? Math.min(48, Math.max(8, Math.round(upscale * 1.5)))
    : 0

  pctx.imageSmoothingEnabled = true
  pctx.imageSmoothingQuality = 'high'
  if (blurPx > 0) pctx.filter = `blur(${blurPx}px)`
  pctx.drawImage(planImg, 0, 0, w, h)
  pctx.filter = 'none'

  // Step 3: feathered mask — blur softens the diff boundary into a gradient
  // and spreads it slightly past the exact edge on both sides.
  const featherPx = Math.max(8, Math.round(Math.min(w, h) * 0.015))
  const maskLayer = document.createElement('canvas')
  maskLayer.width = w
  maskLayer.height = h
  const mctx = maskLayer.getContext('2d')
  if (mctx) {
    mctx.filter = `blur(${featherPx}px)`
    mctx.drawImage(changeMask, 0, 0, w, h)
    mctx.filter = 'none'

    pctx.globalCompositeOperation = 'destination-in'
    pctx.drawImage(maskLayer, 0, 0)
    pctx.globalCompositeOperation = 'source-over'
  }

  // Step 4: composite the masked, softened plan layer over the crisp base.
  cctx.drawImage(planLayer, 0, 0)

  return composite
}

/**
 * Crop one tile's region out of the shared running inpaint canvas.
 *
 * Mirrors `buildTileInput` in the extend pipeline: by the time a tile is
 * generated, the running canvas already contains the global composite (crisp
 * source + softened plan-in-mask) plus the sharpened results of any
 * already-processed neighbour tiles (per the scan-order feathering in
 * `planInpaintTiles`), so a plain crop gives the model real neighbour context
 * for free — no per-tile reconstruction of blur or masking is needed.
 */
export function cropInpaintTileInput(
  runningCanvas: HTMLCanvasElement,
  tileSpec: { x: number; y: number; w: number; h: number },
): string {
  const tile = document.createElement('canvas')
  tile.width = tileSpec.w
  tile.height = tileSpec.h
  const ctx = tile.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(runningCanvas, tileSpec.x, tileSpec.y, tileSpec.w, tileSpec.h, 0, 0, tileSpec.w, tileSpec.h)
  return tile.toDataURL('image/jpeg', 0.92)
}

/**
 * Force every pixel in an ImageData block to alpha 255 so a later
 * source-over stamp cannot blend with whatever is already on the destination.
 */
function forceImageDataOpaque(imageData: ImageData): void {
  const pixels = imageData.data
  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = 255
  }
}

/**
 * Composite a tile result into the running inpaint canvas as a straight
 * overwrite of the selection intersection (`maskSubRect`). The context ring
 * stays original; the edited pixels are the model's RGB at full opacity —
 * no source-underlay, no feather, so the original cannot ghost through.
 */
export async function compositeInpaintTileResult(
  inpaintCanvas: HTMLCanvasElement,
  sourceImageUrl: string,
  tileResultUrl: string,
  tileSpec: InpaintTileSpec,
  contextRect: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const { x: tX, y: tY, w: tW, h: tH, maskSubRect } = tileSpec

  const [tileResultImg, sourceImg] = await Promise.all([
    loadImageElement(tileResultUrl),
    loadImageElement(sourceImageUrl),
  ])

  const tileCanvas = document.createElement('canvas')
  tileCanvas.width = tW
  tileCanvas.height = tH
  const tileCtx = tileCanvas.getContext('2d')

  if (tileCtx) {
    // Context ring: keep the original source pixels outside the selection.
    tileCtx.drawImage(sourceImg, contextRect.x + tX, contextRect.y + tY, tW, tH, 0, 0, tW, tH)

    if (maskSubRect) {
      const msX = Math.max(0, Math.floor(maskSubRect.x))
      const msY = Math.max(0, Math.floor(maskSubRect.y))
      const msW = Math.max(1, Math.min(tW - msX, Math.ceil(maskSubRect.w)))
      const msH = Math.max(1, Math.min(tH - msY, Math.ceil(maskSubRect.h)))

      // Draw the AI tile into a scratch canvas, then replace the selection
      // intersection with those RGB values at alpha 255 — never source-over
      // onto the original, which left ghosts where the model was translucent.
      const scratch = document.createElement('canvas')
      scratch.width = tW
      scratch.height = tH
      const scratchCtx = scratch.getContext('2d')
      if (scratchCtx) {
        scratchCtx.drawImage(tileResultImg, 0, 0, tW, tH)
        const opaqueEdit = scratchCtx.getImageData(msX, msY, msW, msH)
        forceImageDataOpaque(opaqueEdit)
        tileCtx.putImageData(opaqueEdit, msX, msY)
      }
    }

    console.log(
      '[imageProcessor] tileResult natural dimensions:',
      tileResultImg.naturalWidth, '×', tileResultImg.naturalHeight,
      '| tile target:', tW, '×', tH,
    )
  }

  const bandCtx = inpaintCanvas.getContext('2d')
  if (!bandCtx) {
    console.warn('[imageProcessor] compositeInpaintTileResult: could not get 2d context for inpaintCanvas')
    return
  }

  if (!maskSubRect) {
    return
  }

  bandCtx.drawImage(tileCanvas, 0, 0, tW, tH, tX, tY, tW, tH)

  // ── Diagnostic: trace the edit through each stage at the selection centre ──
  //   src        = original source pixel
  //   result     = raw model output (fresh draw, no compositing)
  //   tileCanvas = AI tile after opaque selection overwrite (pre-band)
  //   band       = pixel actually written into the running canvas
  // Interpretation:
  //   tileCanvas ≈ src               → the feather step wiped the edit.
  //   tileCanvas ≈ result, band ≈ src → the band crop-draw isn't landing.
  //   band ≈ result                  → the edit is composited correctly.
  type Rgba = [number, number, number, number]
  const readPixel = (ctx: CanvasRenderingContext2D, x: number, y: number): Rgba => {
    const d = ctx.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
  const tileCx = Math.min(Math.floor(tW) - 1, Math.floor(maskSubRect.x + maskSubRect.w / 2))
  const tileCy = Math.min(Math.floor(tH) - 1, Math.floor(maskSubRect.y + maskSubRect.h / 2))
  const bandCx = Math.min(inpaintCanvas.width - 1, Math.floor(tX + maskSubRect.x + maskSubRect.w / 2))
  const bandCy = Math.min(inpaintCanvas.height - 1, Math.floor(tY + maskSubRect.y + maskSubRect.h / 2))

  const sample = (draw: (c: CanvasRenderingContext2D) => void): Rgba => {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.floor(tW))
    c.height = Math.max(1, Math.floor(tH))
    const cc = c.getContext('2d')
    if (!cc) {
      return [0, 0, 0, 0]
    }
    draw(cc)
    return readPixel(cc, tileCx, tileCy)
  }
  const srcPx: Rgba = sample((c) =>
    c.drawImage(sourceImg, contextRect.x + tX, contextRect.y + tY, tW, tH, 0, 0, tW, tH),
  )
  const resultPx: Rgba = sample((c) => c.drawImage(tileResultImg, 0, 0, tW, tH))
  const tilePx: Rgba = tileCtx ? readPixel(tileCtx, tileCx, tileCy) : [-1, -1, -1, -1]
  const bandPx: Rgba = readPixel(bandCtx, bandCx, bandCy)

  const rgbaToStr = (px: Rgba): string => `[${px[0]}, ${px[1]}, ${px[2]}, ${px[3]}]`
  console.log(
    [
      '[imageProcessor] edit trace (r,g,b,a):',
      `src=${rgbaToStr(srcPx)}`,
      `result=${rgbaToStr(resultPx)}`,
      `tileCanvas=${rgbaToStr(tilePx)}`,
      `band=${rgbaToStr(bandPx)}`,
      `| tile(${tileCx},${tileCy}) band(${bandCx},${bandCy})`,
    ].join(' '),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiled Inpaint Pipeline — global plan input and mask overlay helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Longest edge (px) for the global-plan image sent to the LLM. */
const GLOBAL_PLAN_MAX_DIM = 1356

/**
 * Crop the context region from the source image, scale it so the longest edge
 * is at most GLOBAL_PLAN_MAX_DIM, grey-fill the selection area, and draw a red
 * border around it. Returns the annotated data URL and the scale factor used
 * (context-pixel → plan-pixel).
 *
 * This image is sent to the /api/edit 'plan' phase as the global inpaint input.
 * The prompt instructs the model to fill the grey zone inside the red border.
 */
export async function buildGlobalPlanInput(
  sourceImageUrl: string,
  contextRect: { x: number; y: number; w: number; h: number },
  selectionRect: { x: number; y: number; w: number; h: number },
): Promise<{ dataUrl: string; scale: number }> {
  const img = await loadImageElement(sourceImageUrl)
  const scale = Math.min(1, GLOBAL_PLAN_MAX_DIM / Math.max(contextRect.w, contextRect.h))
  const outW = Math.max(1, Math.round(contextRect.w * scale))
  const outH = Math.max(1, Math.round(contextRect.h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl: sourceImageUrl, scale: 1 }

  // Draw source pixels for the context region, scaled to output size.
  ctx.drawImage(img, contextRect.x, contextRect.y, contextRect.w, contextRect.h, 0, 0, outW, outH)

  // Selection in context-local coordinates, scaled to output size.
  const selX = Math.round((selectionRect.x - contextRect.x) * scale)
  const selY = Math.round((selectionRect.y - contextRect.y) * scale)
  const selW = Math.max(1, Math.round(selectionRect.w * scale))
  const selH = Math.max(1, Math.round(selectionRect.h * scale))

  // Grey-fill the selection so the model has a clear zone to fill.
  ctx.fillStyle = EXTENSION_BLANK_COLOR
  ctx.fillRect(selX, selY, selW, selH)

  // Red border — unambiguous boundary marker; prompt says only inside may change.
  const borderPx = Math.max(3, Math.round(Math.min(outW, outH) * 0.008))
  ctx.strokeStyle = '#FF0000'
  ctx.lineWidth = borderPx
  ctx.strokeRect(
    selX + borderPx / 2,
    selY + borderPx / 2,
    selW - borderPx,
    selH - borderPx,
  )

  return { dataUrl: canvas.toDataURL('image/png'), scale }
}

/**
 * Composite the B&W change-mask extracted from the global plan onto the plan
 * result image as a semi-transparent blue highlight. Returns a data URL for
 * display in the sidebar — never sent to the API.
 *
 * WHITE mask pixels → blue highlight at ~55 % opacity
 * BLACK mask pixels → plan image unchanged
 */
export async function buildMaskOverlay(
  globalPlanUrl: string,
  globalMaskUrl: string,
): Promise<string> {
  const [planImg, maskImg] = await Promise.all([
    loadImageElement(globalPlanUrl),
    loadImageElement(globalMaskUrl),
  ])

  const w = planImg.naturalWidth
  const h = planImg.naturalHeight

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return globalPlanUrl

  // Draw the global plan.
  ctx.drawImage(planImg, 0, 0)

  // Stretch the mask to match plan dimensions and read pixel data.
  const offscreen = document.createElement('canvas')
  offscreen.width = w
  offscreen.height = h
  const offCtx = offscreen.getContext('2d')
  if (!offCtx) return globalPlanUrl
  offCtx.drawImage(maskImg, 0, 0, w, h)
  const maskData = offCtx.getImageData(0, 0, w, h)

  // Build a blue-highlight layer from the mask's white pixels.
  const overlayData = ctx.createImageData(w, h)
  for (let i = 0; i < maskData.data.length; i += 4) {
    const brightness = maskData.data[i]  // R channel (B&W: R = G = B)
    if (brightness > 128) {
      const alpha = Math.round(((brightness - 128) / 127) * 180)
      overlayData.data[i]     = 30   // R
      overlayData.data[i + 1] = 100  // G
      overlayData.data[i + 2] = 220  // B
      overlayData.data[i + 3] = alpha
    }
  }

  const overlayCanvas = document.createElement('canvas')
  overlayCanvas.width = w
  overlayCanvas.height = h
  const overlayCtx = overlayCanvas.getContext('2d')
  if (overlayCtx) {
    overlayCtx.putImageData(overlayData, 0, 0)
  }
  ctx.drawImage(overlayCanvas, 0, 0)

  return canvas.toDataURL('image/jpeg', 0.92)
}

/**
 * Stamp the completed inpaint canvas back into the full source image at
 * `contextRect` as a straight overwrite (model RGB at alpha 255). Called
 * by EditStudio for Accept and the stitched preview.
 */
export async function compositeInpaintFinal(
  sourceImageUrl: string,
  inpaintCanvas: HTMLCanvasElement,
  contextRect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const img = await loadImageElement(sourceImageUrl)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return sourceImageUrl
  }
  ctx.drawImage(img, 0, 0)

  const destX = Math.max(0, Math.floor(contextRect.x))
  const destY = Math.max(0, Math.floor(contextRect.y))
  const destW = inpaintCanvas.width
  const destH = inpaintCanvas.height

  const stamp = document.createElement('canvas')
  stamp.width = destW
  stamp.height = destH
  const stampCtx = stamp.getContext('2d')
  if (!stampCtx) {
    ctx.drawImage(inpaintCanvas, contextRect.x, contextRect.y)
    return canvas.toDataURL('image/png')
  }
  stampCtx.drawImage(inpaintCanvas, 0, 0)
  const opaqueStamp = stampCtx.getImageData(0, 0, destW, destH)
  forceImageDataOpaque(opaqueStamp)
  ctx.putImageData(opaqueStamp, destX, destY)
  return canvas.toDataURL('image/png')
}

/**
 * Paste the model's plan crop into a context-sized canvas as a straight
 * overwrite. No change-mask, blur, or feather — the plan RGB replaces the
 * source in `contextRect` at alpha 255 so a later Accept cannot blend.
 */
export async function stampPlanIntoContextCanvas(
  sourceImageUrl: string,
  contextRect: { x: number; y: number; w: number; h: number },
  planImageUrl: string,
): Promise<HTMLCanvasElement> {
  const [sourceImg, planImg] = await Promise.all([
    loadImageElement(sourceImageUrl),
    loadImageElement(planImageUrl),
  ])
  const destW = Math.max(1, Math.round(contextRect.w))
  const destH = Math.max(1, Math.round(contextRect.h))
  const canvas = document.createElement('canvas')
  canvas.width = destW
  canvas.height = destH
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return canvas
  }

  // Original context as the fallback under the plan, then replace it.
  ctx.drawImage(
    sourceImg,
    contextRect.x,
    contextRect.y,
    destW,
    destH,
    0,
    0,
    destW,
    destH,
  )
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(planImg, 0, 0, destW, destH)

  const opaqueStamp = ctx.getImageData(0, 0, destW, destH)
  forceImageDataOpaque(opaqueStamp)
  ctx.putImageData(opaqueStamp, 0, 0)
  return canvas
}

/**
 * Paste the model's plan crop into the source at `contextRect` with no
 * extra blur, change-mask, or feather. The only softness is the plan's
 * own resolution (longest edge ≤ GLOBAL_PLAN_MAX_DIM). Used for the
 * on-screen merge preview and Accept so both show a hard overwrite.
 */
export async function stampPlanIntoSource(
  sourceImageUrl: string,
  contextRect: { x: number; y: number; w: number; h: number },
  planImageUrl: string,
): Promise<string> {
  const sourceImg = await loadImageElement(sourceImageUrl)
  const stampedContext = await stampPlanIntoContextCanvas(
    sourceImageUrl,
    contextRect,
    planImageUrl,
  )
  const canvas = document.createElement('canvas')
  canvas.width = sourceImg.naturalWidth
  canvas.height = sourceImg.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return sourceImageUrl
  }
  ctx.drawImage(sourceImg, 0, 0)

  const destX = Math.max(0, Math.floor(contextRect.x))
  const destY = Math.max(0, Math.floor(contextRect.y))
  const destW = stampedContext.width
  const destH = stampedContext.height
  const stampCtx = stampedContext.getContext('2d')
  if (stampCtx) {
    const opaqueStamp = stampCtx.getImageData(0, 0, destW, destH)
    ctx.putImageData(opaqueStamp, destX, destY)
  } else {
    ctx.drawImage(stampedContext, destX, destY)
  }
  return canvas.toDataURL('image/png')
}
