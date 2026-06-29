'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EDIT_STRIP_PX,
  MAX_EDIT_SELECTION_PX,
  type InpaintState,
  type InpaintRegion,
  type ReferenceImage,
} from '@/app/lib/app'
import { EditPanel } from '@/app/components/EditPanel'
import {
  buildLowResContextCrop,
  buildInpaintContextInput,
  buildInpaintResultCanvas,
  compositeInpaintFinal,
} from '@/app/utils/imageProcessor'

// ─────────────────────────────────────────────────────────────────────────────
// Canvas helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Promise-wrapper around Image.onload. */
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/**
 * Composite the AI-generated B&W mask onto the context crop as a blue
 * highlight: white mask pixels → semi-transparent blue (#1e64dc at ~55% opacity).
 * The result replaces `lowResPreviewUrl` so the panel always shows the mask
 * overlaid on the original image rather than as a raw B&W image.
 */
async function buildMaskOverlayPreview(
  contextCropUrl: string,
  maskUrl: string,
): Promise<string> {
  const [cropImg, maskImg] = await Promise.all([loadImg(contextCropUrl), loadImg(maskUrl)])

  const w = cropImg.naturalWidth
  const h = cropImg.naturalHeight

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return contextCropUrl

  // Draw the original context crop.
  ctx.drawImage(cropImg, 0, 0)

  // Read the B&W mask (stretched to match crop dimensions).
  const offscreen = document.createElement('canvas')
  offscreen.width = w
  offscreen.height = h
  const offCtx = offscreen.getContext('2d')
  if (!offCtx) return contextCropUrl
  offCtx.drawImage(maskImg, 0, 0, w, h)
  const maskData = offCtx.getImageData(0, 0, w, h)

  // Build a blue-highlight layer from the mask's white pixels.
  const overlayData = ctx.createImageData(w, h)
  for (let i = 0; i < maskData.data.length; i += 4) {
    const brightness = maskData.data[i] // R channel (B&W: R = G = B)
    if (brightness > 128) {
      // Map mask brightness → alpha (brighter white = more opaque blue).
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

  // Composite the blue overlay onto the context crop.
  ctx.drawImage(overlayCanvas, 0, 0)

  // Draw a white border around the masked region's bounding box so the
  // boundary is as clear as the selection-box style.
  // Find the bounding box of white pixels in the mask.
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (maskData.data[(y * w + x) * 4] > 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX > minX && maxY > minY) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1.5, w / 200)
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)
  }

  return canvas.toDataURL('image/jpeg', 0.92)
}

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

/** A point in image-pixel space. */
type ImagePoint = { x: number; y: number }

/** An axis-aligned rectangle in image-pixel space. */
type ImageRect = { x: number; y: number; w: number; h: number }

/**
 * Active drag state. `start` and `current` are in image-pixel coordinates.
 * `committed` is true once the user releases the mouse button.
 */
type DragState = {
  start: ImagePoint
  current: ImagePoint
  committed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Convert a MouseEvent's client coordinates into image-pixel coordinates,
 * mapping the displayed canvas element to the natural image dimensions.
 */
function toImageCoord(
  e: React.MouseEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
): ImagePoint {
  const rect = canvas.getBoundingClientRect()
  const scaleX = imgW / rect.width
  const scaleY = imgH / rect.height
  return {
    x: clamp((e.clientX - rect.left) * scaleX, 0, imgW),
    y: clamp((e.clientY - rect.top) * scaleY, 0, imgH),
  }
}

function normaliseRect(a: ImagePoint, b: ImagePoint): ImageRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

function outsetRect(r: ImageRect, amount: number, container: ImageRect): ImageRect {
  return {
    x: Math.max(container.x, r.x - amount),
    y: Math.max(container.y, r.y - amount),
    w: Math.min(container.x + container.w, r.x + r.w + amount) - Math.max(container.x, r.x - amount),
    h: Math.min(container.y + container.h, r.y + r.h + amount) - Math.max(container.y, r.y - amount),
  }
}

function clampRect(r: ImageRect, bounds: ImageRect): ImageRect {
  const x = clamp(r.x, bounds.x, bounds.x + bounds.w)
  const y = clamp(r.y, bounds.y, bounds.y + bounds.h)
  const x2 = clamp(r.x + r.w, bounds.x, bounds.x + bounds.w)
  const y2 = clamp(r.y + r.h, bounds.y, bounds.y + bounds.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

/**
 * Largest rectangle the user can select starting from `start`, limited by
 * MAX_EDIT_SELECTION_PX and the image boundary.
 */
function computeDynamicMaxRect(start: ImagePoint, imageBounds: ImageRect): ImageRect {
  const limit = Math.max(0, MAX_EDIT_SELECTION_PX)
  const x1 = Math.max(imageBounds.x, start.x - limit)
  const y1 = Math.max(imageBounds.y, start.y - limit)
  const x2 = Math.min(imageBounds.x + imageBounds.w, start.x + limit)
  const y2 = Math.min(imageBounds.y + imageBounds.h, start.y + limit)
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

function drawRect(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
  scaleX: number,
  scaleY: number,
  options: {
    strokeStyle: string
    fillStyle?: string
    lineWidth?: number
    dash?: number[]
  },
): void {
  const { strokeStyle, fillStyle, lineWidth = 1.5, dash = [] } = options
  ctx.save()
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.setLineDash(dash)
  if (fillStyle) {
    ctx.fillStyle = fillStyle
    ctx.fillRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY)
  }
  ctx.strokeRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY)
  ctx.restore()
}

/**
 * Draw a white label just outside the top-left corner of a rectangle.
 * Flips below the top edge if the rectangle is too close to the canvas top.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
  scaleX: number,
  scaleY: number,
  text: string,
  fontPx: number = 80,
): void {
  const scaledFont = fontPx * scaleY
  const pad = 6 * scaleY
  const cx = r.x * scaleX + pad
  const aboveY = r.y * scaleY - pad
  const cy = aboveY >= scaledFont ? aboveY : r.y * scaleY + scaledFont + pad
  ctx.save()
  ctx.font = `600 ${scaledFont}px ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.shadowColor = 'rgba(0,0,0,0.85)'
  ctx.shadowBlur = 6 * scaleY
  ctx.fillText(text, cx, cy)
  ctx.restore()
}

/**
 * Render the selection overlay and (when tiling) the tile grid onto the canvas.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  drag: DragState | null,
  inpaintState: InpaintState | null,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const bufW = canvas.width
  const bufH = canvas.height
  ctx.clearRect(0, 0, bufW, bufH)

  const scaleX = bufW / imgW
  const scaleY = bufH / imgH

  // Faint boundary guide — always visible.
  const maxStripRect: ImageRect = { x: 0, y: 0, w: imgW, h: imgH }
  drawRect(ctx, maxStripRect, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,0.4)',
    lineWidth: 1.5,
    dash: [6, 4],
  })

  if (!drag) return

  const dynamicMax = computeDynamicMaxRect(drag.start, maxStripRect)
  const rawSelect = normaliseRect(drag.start, drag.current)
  const currentSelect = clampRect(rawSelect, dynamicMax)

  if (currentSelect.w < 2 || currentSelect.h < 2) return

  // Context strip around the selection.
  const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, maxStripRect)
  drawRect(ctx, currentStrip, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(60,140,255,0.18)',
    lineWidth: 6,
  })
  drawLabel(ctx, currentStrip, scaleX, scaleY, 'Context')

  // Selection rectangle.
  drawRect(ctx, currentSelect, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(30,100,220,0.22)',
    lineWidth: 6,
  })
  drawLabel(ctx, currentSelect, scaleX, scaleY, 'Selection')

  // Tile grid overlay (visible during tiling phase).
  if (
    inpaintState &&
    (inpaintState.phase === 'tiling' || inpaintState.phase === 'done') &&
    inpaintState.tilePlan
  ) {
    const { tilePlan, tileResults, generatingTileIdx } = inpaintState
    const { contextRect } = inpaintState.region

    for (let i = 0; i < tilePlan.tiles.length; i++) {
      const tile = tilePlan.tiles[i]
      const isMasked = tile.maskSubRect !== null
      const isGenerating = generatingTileIdx === i
      const isDone = tileResults[i] !== null

      if (!isMasked) continue

      const tileRect: ImageRect = {
        x: contextRect.x + tile.x,
        y: contextRect.y + tile.y,
        w: tile.w,
        h: tile.h,
      }

      let strokeStyle = 'rgba(255,255,255,0.3)'
      let fillStyle: string | undefined
      if (isDone) {
        strokeStyle = 'rgba(40,200,80,0.8)'
        fillStyle = 'rgba(40,200,80,0.1)'
      }
      if (isGenerating) {
        strokeStyle = 'rgba(60,140,255,0.9)'
        fillStyle = 'rgba(60,140,255,0.15)'
      }

      drawRect(ctx, tileRect, scaleX, scaleY, {
        strokeStyle,
        fillStyle,
        lineWidth: 2,
        dash: isDone || isGenerating ? [] : [4, 3],
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EmptyEditState
// ─────────────────────────────────────────────────────────────────────────────

function EmptyEditState({
  onPickFile,
  onDropFile,
}: {
  onPickFile: () => void
  onDropFile: (file: File) => void
}) {
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }
  const handleDragLeave = () => setIsDragOver(false)
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onDropFile(file)
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 pb-6 pt-2">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed p-12 text-center transition-colors"
        style={{
          borderColor: isDragOver ? 'var(--accent)' : 'var(--border)',
          background: isDragOver ? 'rgba(var(--accent-rgb),0.04)' : 'transparent',
        }}
      >
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Load an image in <strong>Extender</strong> first, then switch to Edit to select a region.
        </p>
        <button onClick={onPickFile} className="btn btn-ghost text-[12px]">
          Upload image
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EditStudio
// ─────────────────────────────────────────────────────────────────────────────

export interface EditStudioProps {
  image: string | null
  dimensions: { width: number; height: number } | null
  onPickFile: () => void
  onDropFile: (file: File) => void
  apiKey: string
  model: string
  onAccept: (newImageUrl: string) => void
}

/**
 * Edit mode workspace.
 *
 * Renders the source image with a transparent canvas overlay for selection
 * drawing. Once a selection is committed the Tiled Inpaint Pipeline is
 * orchestrated here:
 *
 *   1. Build low-res context crop (preview + mask input)
 *   2. EditPanel stage 1 — user picks mask mode / types a description
 *   3. Optional mask generation via /api/edit-mask
 *   4. EditPanel stage 2 — user enters edit prompt + optional reference images
 *   5. Phase 1: global plan via /api/edit (phase:'plan')
 *   6. Phase 2: per-tile high-res via /api/edit (phase:'refine') in scan order
 *   7. Accept → composite inpaint canvas back into full image
 */
/** Screen-space position for the floating popup. */
type PopupPos = { x: number; y: number }

const POPUP_W = 380
const POPUP_H = 640
const POPUP_GAP = 12


export function EditStudio({ image, dimensions, onPickFile, onDropFile, apiKey, model, onAccept }: EditStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDraggingRef = useRef(false)
  /** Running composite surface for the tiled inpaint pass. */
  const inpaintCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [drag, setDrag] = useState<DragState | null>(null)
  const [inpaintState, setInpaintState] = useState<InpaintState | null>(null)
  const [popupPos, setPopupPos] = useState<PopupPos | null>(null)

  // ── Sync canvas buffer to natural image dimensions ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  // ── Redraw overlay on drag or inpaint state changes ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) return
    renderOverlay(canvas, dimensions.width, dimensions.height, drag, inpaintState)
  }, [drag, dimensions, inpaintState])

  // ── Build low-res context crop + annotated preview when selection commits ────
  useEffect(() => {
    if (!drag?.committed || !image || !dimensions) return

    const maxStripRect: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const dynamicMax = computeDynamicMaxRect(drag.start, maxStripRect)
    const sel = clampRect(normaliseRect(drag.start, drag.current), dynamicMax)
    if (sel.w < 8 || sel.h < 8) return

    const contextRect = outsetRect(sel, EDIT_STRIP_PX, maxStripRect)

    buildLowResContextCrop(image, contextRect).then(({ dataUrl, scale }) => {
      // Build annotated preview: draw the selection rectangle on the clean crop.
      const selInCtx = {
        x: sel.x - contextRect.x,
        y: sel.y - contextRect.y,
        w: sel.w,
        h: sel.h,
      }

      const img = new window.Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0)
          const lrX = selInCtx.x * scale
          const lrY = selInCtx.y * scale
          const lrW = selInCtx.w * scale
          const lrH = selInCtx.h * scale
          ctx.fillStyle = 'rgba(30,100,220,0.18)'
          ctx.fillRect(lrX, lrY, lrW, lrH)
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = Math.max(1.5, scale * 2)
          ctx.strokeRect(lrX, lrY, lrW, lrH)
        }
        const previewUrl = canvas.toDataURL('image/jpeg', 0.92)
        setInpaintState((prev) =>
          prev ? { ...prev, lowResContextUrl: dataUrl, lowResPreviewUrl: previewUrl, lowResScale: scale } : null,
        )
      }
      img.src = dataUrl
    }).catch(() => {})
  }, [drag, image, dimensions])

  // ── Popup position: screen-space anchor next to the committed selection ──────
  // Reads the canvas bounding rect so the popup tracks the displayed image
  // regardless of how the browser has scaled it.

  useLayoutEffect(() => {
    if (!inpaintState || !dimensions) {
      setPopupPos(null)
      return
    }

    const compute = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const scaleX = rect.width / dimensions.width
      const scaleY = rect.height / dimensions.height
      const sel = inpaintState.region.selectionRect

      // Right edge of the selection in screen coordinates.
      const selRight  = rect.left + (sel.x + sel.w) * scaleX
      const selLeft   = rect.left + sel.x * scaleX
      const selTop    = rect.top  + sel.y * scaleY
      const selBottom = rect.top  + (sel.y + sel.h) * scaleY

      // Prefer right of selection; flip left if it would overflow the viewport.
      let x = selRight + POPUP_GAP
      if (x + POPUP_W > window.innerWidth - 8) {
        x = selLeft - POPUP_W - POPUP_GAP
      }
      // Clamp to viewport horizontally.
      x = Math.max(8, Math.min(x, window.innerWidth - POPUP_W - 8))

      // Vertically: align popup top to selection top.
      // If the selection is taller than the popup, centre them instead.
      let y = selTop
      if (selBottom - selTop > POPUP_H) {
        y = (selTop + selBottom) / 2 - POPUP_H / 2
      }
      // Clamp so the full popup height stays within the viewport.
      y = Math.max(8, Math.min(y, window.innerHeight - POPUP_H - 8))

      setPopupPos({ x, y })
    }

    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [inpaintState, dimensions])

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dimensions) return
      const canvas = canvasRef.current
      if (!canvas) return
      // Don't start a new selection while an inpaint session is active.
      if (inpaintState) return
      e.preventDefault()
      isDraggingRef.current = true
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag({ start: pt, current: pt, committed: false })
    },
    [dimensions, inpaintState],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) return
      const canvas = canvasRef.current
      if (!canvas) return
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag((prev) => (prev ? { ...prev, current: pt } : null))
    },
    [dimensions],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) return
      isDraggingRef.current = false
      const canvas = canvasRef.current
      if (!canvas) return
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)

      setDrag((prev) => {
        if (!prev) return null
        const raw = normaliseRect(prev.start, pt)
        if (raw.w < 8 || raw.h < 8) return null
        return { ...prev, current: pt, committed: true }
      })
    },
    [dimensions],
  )

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false
      setDrag((prev) => {
        if (!prev) return null
        const raw = normaliseRect(prev.start, prev.current)
        if (raw.w < 8 || raw.h < 8) return null
        return { ...prev, committed: true }
      })
    }
  }, [])

  // ── Initialise InpaintState when drag commits ──────────────────────────────
  useEffect(() => {
    if (!drag?.committed || !dimensions || inpaintState) return

    const maxStripRect: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const dynamicMax = computeDynamicMaxRect(drag.start, maxStripRect)
    const sel = clampRect(normaliseRect(drag.start, drag.current), dynamicMax)
    if (sel.w < 8 || sel.h < 8) return

    const contextRect = outsetRect(sel, EDIT_STRIP_PX, maxStripRect)

    const region: InpaintRegion = {
      selectionRect: sel,
      maskType: 'rect',
      contextRect,
    }

    setInpaintState({
      phase: 'mask',
      region,
      editPrompt: '',
      referenceImages: [],
      lowResContextUrl: null,
      lowResPreviewUrl: null,
      maskOverlayUrl: null,
      lowResScale: 1,
      globalPlanUrl: null,
      tilePlan: null,
      tileResults: [],
      generatingTileIdx: null,
      maskGenerating: false,
      error: null,
      tileDebugInputUrl: null,
      tileDebugResultUrl: null,
    })
  }, [drag, dimensions, inpaintState])

  // ── Callback: user confirms mask choice ────────────────────────────────────

  const handleMaskConfirm = useCallback(
    async (maskMode: 'rect' | 'image', maskDescription: string) => {
      if (!inpaintState) return

      if (maskMode === 'rect') {
        // Use selection box — advance immediately to prompt stage.
        setInpaintState((prev) =>
          prev
            ? { ...prev, phase: 'prompt', region: { ...prev.region, maskType: 'rect', maskImageUrl: undefined }, error: null }
            : null,
        )
        return
      }

      // Text-mask path: generate a B&W mask from the description.
      if (!maskDescription.trim()) {
        setInpaintState((prev) => (prev ? { ...prev, error: 'Enter a mask description.' } : null))
        return
      }
      if (!inpaintState.lowResContextUrl) {
        setInpaintState((prev) => (prev ? { ...prev, error: 'Context preview not ready. Please wait.' } : null))
        return
      }

      setInpaintState((prev) => (prev ? { ...prev, maskGenerating: true, error: null } : null))

      try {
        const res = await fetch('/api/edit-mask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contextDataUrl: inpaintState.lowResContextUrl,
            maskDescription: maskDescription.trim(),
            apiKey,
            model,
          }),
        })
        const data = await res.json() as { maskUrl?: string; error?: string }
        if (!res.ok || !data.maskUrl) throw new Error(data.error ?? 'Mask generation failed')

        // Build the mask overlay: B&W mask composited as a blue highlight
        // over the context crop. Stored separately so the original selection
        // preview is unchanged and this appears as a second image below it.
        const maskOverlayUrl = inpaintState.lowResContextUrl
          ? await buildMaskOverlayPreview(inpaintState.lowResContextUrl, data.maskUrl).catch(() => null)
          : null

        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                phase: 'prompt',
                maskGenerating: false,
                maskOverlayUrl,
                region: { ...prev.region, maskType: 'image', maskImageUrl: data.maskUrl },
                error: null,
              }
            : null,
        )
      } catch (e) {
        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                maskGenerating: false,
                error: e instanceof Error ? e.message : 'Mask generation failed',
              }
            : null,
        )
      }
    },
    [inpaintState, apiKey, model],
  )

  // ── Callback: user confirms prompt — kick off planning + tiling ────────────

  const handlePromptConfirm = useCallback(
    async (editPrompt: string, referenceImages: ReferenceImage[]) => {
      if (!inpaintState || !image) return

      const { region } = inpaintState
      const { selectionRect, contextRect, maskType, maskImageUrl } = region

      setInpaintState((prev) =>
        prev ? { ...prev, phase: 'planning', editPrompt, referenceImages, error: null } : null,
      )

      try {
        // Build the context crop at full resolution (capped at 1536 px) with
        // the selection area greyed out — exactly what the extend pipeline does
        // for its blank extension strip.
        const { dataUrl: contextInputUrl } = await buildInpaintContextInput(
          image,
          contextRect,
          selectionRect,
          maskType === 'image' ? maskImageUrl : undefined,
        )

        // Single API call — same approach as the extend pipeline.
        const res = await fetch('/api/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'plan',
            imageDataUrl: contextInputUrl,
            editPrompt,
            referenceImages,
            maskDataUrl: maskType === 'image' ? maskImageUrl : undefined,
            apiKey,
            model,
          }),
        })
        const data = await res.json() as { resultUrl?: string; error?: string }
        if (!res.ok || !data.resultUrl) throw new Error(data.error ?? 'Generation failed')

        // Load the model result into an inpaint canvas sized to the context rect.
        const inpaintCanvas = await buildInpaintResultCanvas(data.resultUrl, contextRect)
        inpaintCanvasRef.current = inpaintCanvas
        console.log('[EditStudio] inpaintCanvas from result', {
          w: inpaintCanvas.width,
          h: inpaintCanvas.height,
          resultUrlLength: data.resultUrl.length,
        })

        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                phase: 'done',
                globalPlanUrl: data.resultUrl ?? null,
                tileResults: [data.resultUrl ?? null],
                tileDebugInputUrl: contextInputUrl,
                tileDebugResultUrl: data.resultUrl ?? null,
                error: null,
              }
            : null,
        )
      } catch (e) {
        setInpaintState((prev) =>
          prev
            ? { ...prev, phase: 'prompt', error: e instanceof Error ? e.message : 'Generation failed' }
            : null,
        )
      }
    },
    [inpaintState, image, apiKey, model],
  )

  // ── Callback: accept — stamp inpaint canvas into full image ────────────────

  const handleAccept = useCallback(async () => {
    const inpaintCanvas = inpaintCanvasRef.current

    // Diagnostic guard — surface any blocking condition visibly rather than
    // returning silently (makes it easy to spot issues during development).
    if (!inpaintCanvas) {
      console.warn('[EditStudio] handleAccept: inpaintCanvas is null')
      setInpaintState((prev) => prev ? { ...prev, error: 'Cannot accept: inpaint canvas is missing. Please try regenerating.' } : null)
      return
    }
    if (!image) {
      console.warn('[EditStudio] handleAccept: image prop is null/empty')
      setInpaintState((prev) => prev ? { ...prev, error: 'Cannot accept: source image is missing.' } : null)
      return
    }
    if (!inpaintState) {
      console.warn('[EditStudio] handleAccept: inpaintState is null')
      return
    }

    try {
      console.log('[EditStudio] handleAccept: compositing final image…', {
        contextRect: inpaintState.region.contextRect,
        canvasW: inpaintCanvas.width,
        canvasH: inpaintCanvas.height,
      })
      const newImageUrl = await compositeInpaintFinal(image, inpaintCanvas, inpaintState.region.contextRect)
      const isSameAsSource = newImageUrl === image
      console.log('[EditStudio] handleAccept: composite done', {
        urlLength: newImageUrl.length,
        sourceLength: image.length,
        isSameAsSource,
        newPrefix: newImageUrl.slice(0, 40),
        srcPrefix: image.slice(0, 40),
      })
      onAccept(newImageUrl)
      setInpaintState(null)
      setDrag(null)
      inpaintCanvasRef.current = null
    } catch (e) {
      console.error('[EditStudio] handleAccept error:', e)
      setInpaintState((prev) =>
        prev ? { ...prev, error: e instanceof Error ? e.message : 'Compositing failed' } : null,
      )
    }
  }, [image, inpaintState, onAccept])

  // ── Callback: discard — reset to prompt stage ──────────────────────────────

  const handleDiscard = useCallback(() => {
    inpaintCanvasRef.current = null
    setInpaintState((prev) =>
      prev
        ? { ...prev, phase: 'prompt', globalPlanUrl: null, tilePlan: null, tileResults: [], generatingTileIdx: null, error: null }
        : null,
    )
  }, [])

  // ── Callback: close panel — clear everything ───────────────────────────────

  const handleClose = useCallback(() => {
    inpaintCanvasRef.current = null
    setInpaintState(null)
    setDrag(null)
  }, [])

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!image || !dimensions) {
    return <EmptyEditState onPickFile={onPickFile} onDropFile={onDropFile} />
  }

  const isProcessing = inpaintState?.phase === 'planning' || inpaintState?.phase === 'tiling'

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 pb-6 pt-2">
      {/* Image + canvas overlay */}
      <div className="relative anim-fade">
        <div
          className="relative overflow-hidden checker rounded-[var(--radius-lg)]"
          style={{
            border: '1px solid var(--border)',
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
          }}
        >
          {/* Image always uses full available width — popup floats on top */}
          <img
            src={image}
            alt=""
            className="block object-contain anim-fade max-h-[calc(100vh-260px)] max-w-[min(1200px,calc(100vw-96px))]"
            draggable={false}
          />

          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              cursor: inpaintState || isProcessing ? 'default' : 'crosshair',
              touchAction: 'none',
              pointerEvents: inpaintState || isProcessing ? 'none' : 'auto',
            }}
          />
        </div>

        {/* Below-image meta row — fixed height so the image never shifts */}
        <div className="mt-5 flex h-8 items-center gap-3 anim-slide-up">
          <div
            className="rounded-full border px-2.5 py-1 font-mono text-[11px]"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--bg-elev)',
              color: 'var(--text-secondary)',
            }}
          >
            {dimensions.width} × {dimensions.height}
          </div>
          <div className="flex h-full items-center">
            {!drag && !inpaintState && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Click and drag to select a region
              </span>
            )}
            {drag && !drag.committed && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Release to confirm selection
              </span>
            )}
            {drag?.committed && !inpaintState && (
              <button
                className="btn btn-ghost text-[12px]"
                style={{ height: '100%', padding: '0 10px' }}
                onClick={() => setDrag(null)}
              >
                Clear selection
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Floating popup — anchored next to the committed selection */}
      {inpaintState && popupPos && (
        <div
          className="anim-fade"
          style={{
            position: 'fixed',
            left: popupPos.x,
            top: popupPos.y,
            width: POPUP_W,
            height: Math.min(POPUP_H, window.innerHeight - 16),
            maxHeight: 'calc(100vh - 16px)',
            zIndex: 50,
            borderRadius: 14,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.35)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <EditPanel
            inpaintState={inpaintState}
            apiKey={apiKey}
            model={model}
            onMaskConfirm={(maskMode, desc) => { void handleMaskConfirm(maskMode, desc) }}
            onPromptConfirm={(prompt, refs) => { void handlePromptConfirm(prompt, refs) }}
            onAccept={() => { void handleAccept() }}
            onDiscard={handleDiscard}
            onClose={handleClose}
          />
        </div>
      )}
    </div>
  )
}
