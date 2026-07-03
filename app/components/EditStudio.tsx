'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EDIT_STRIP_PX,
  MAX_AI_DIMENSION,
  type InpaintState,
  type InpaintRegion,
  type InpaintTilePlan,
  type ReferenceImage,
} from '@/app/lib/app'
import { EditPanel } from '@/app/components/EditPanel'
import { Icons } from '@/app/components/icons'
import {
  buildLowResContextCrop,
  buildGlobalPlanInput,
  planInpaintTiles,
  computeChangeMask,
  buildChangeMaskVisuals,
  buildGlobalInpaintComposite,
  cropInpaintTileInput,
  compositeInpaintTileResult,
  compositeInpaintFinal,
} from '@/app/utils/imageProcessor'

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

/** Layout of an object-contain image inside a fixed container. */
type ObjectContainLayout = {
  containerW: number
  containerH: number
  imgW: number
  imgH: number
  /** Uniform scale from image pixels to CSS pixels. */
  s: number
  /** CSS-pixel inset of the fitted image within the container. */
  offsetX: number
  offsetY: number
}

function computeObjectContainLayout(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): ObjectContainLayout {
  const s = Math.min(containerW / imgW, containerH / imgH)
  const displayW = imgW * s
  const displayH = imgH * s
  return {
    containerW,
    containerH,
    imgW,
    imgH,
    s,
    offsetX: (containerW - displayW) / 2,
    offsetY: (containerH - displayH) / 2,
  }
}

function clientToImageCoord(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  layout: ObjectContainLayout,
): ImagePoint {
  const localX = clientX - rect.left - layout.offsetX
  const localY = clientY - rect.top - layout.offsetY
  return {
    x: clamp(localX / layout.s, 0, layout.imgW),
    y: clamp(localY / layout.s, 0, layout.imgH),
  }
}

/**
 * Convert a MouseEvent's client coordinates into image-pixel coordinates,
 * accounting for object-contain letterboxing inside the overlay canvas.
 */
function toImageCoord(
  e: React.MouseEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
): ImagePoint {
  const rect = canvas.getBoundingClientRect()
  const layout = computeObjectContainLayout(rect.width, rect.height, imgW, imgH)
  return clientToImageCoord(e.clientX, e.clientY, rect, layout)
}

function imageToBufferCoord(
  ix: number,
  iy: number,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
): ImagePoint {
  return {
    x: (layout.offsetX + ix * layout.s) * bufW / layout.containerW,
    y: (layout.offsetY + iy * layout.s) * bufH / layout.containerH,
  }
}

function imageRectToBuffer(
  r: ImageRect,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
): ImageRect {
  const tl = imageToBufferCoord(r.x, r.y, layout, bufW, bufH)
  const br = imageToBufferCoord(r.x + r.w, r.y + r.h, layout, bufW, bufH)
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
}

/** Approximate image-pixel → canvas-buffer scale for stroke widths and labels. */
function imagePixelScaleInBuffer(layout: ObjectContainLayout, bufH: number): number {
  return layout.s * bufH / layout.containerH
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

/** Normalise and clamp an in-progress or committed drag to the image bounds. */
function selectionFromDrag(drag: DragState, imageBounds: ImageRect): ImageRect {
  return clampRect(normaliseRect(drag.start, drag.current), imageBounds)
}

/** Snap drag corners to the clamped selection so overlay and preview stay aligned. */
function committedDragFromSelection(
  drag: DragState,
  sel: ImageRect,
): DragState {
  return {
    start: { x: sel.x, y: sel.y },
    current: { x: sel.x + sel.w, y: sel.y + sel.h },
    committed: true,
  }
}

/** Build a filesystem-safe timestamp for download filenames. */
function timestampForFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

function drawBufferRect(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
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
    ctx.fillRect(r.x, r.y, r.w, r.h)
  }
  ctx.strokeRect(r.x, r.y, r.w, r.h)
  ctx.restore()
}

function drawImageRect(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
  options: {
    strokeStyle: string
    fillStyle?: string
    lineWidth?: number
    dash?: number[]
  },
): void {
  const buf = imageRectToBuffer(r, layout, bufW, bufH)
  const pixelScale = imagePixelScaleInBuffer(layout, bufH)
  drawBufferRect(ctx, buf, {
    ...options,
    lineWidth: (options.lineWidth ?? 1.5) * pixelScale,
  })
}

/**
 * Draw a white label just outside the top-left corner of a rectangle.
 * Flips below the top edge when the rectangle is near the canvas top.
 */
function drawImageLabel(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
  text: string,
  fontPx: number = 80,
): void {
  const buf = imageRectToBuffer(r, layout, bufW, bufH)
  const pixelScale = imagePixelScaleInBuffer(layout, bufH)
  const scaledFont = fontPx * pixelScale
  const pad = 6 * pixelScale
  const cx = buf.x + pad
  const aboveY = buf.y - pad
  const cy = aboveY >= scaledFont ? aboveY : buf.y + scaledFont + pad
  ctx.save()
  ctx.font = `600 ${scaledFont}px ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.shadowColor = 'rgba(0,0,0,0.85)'
  ctx.shadowBlur = 6 * pixelScale
  ctx.fillText(text, cx, cy)
  ctx.restore()
}

/**
 * Render the selection overlay and (during tiling) the tile grid onto the
 * overlay canvas.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  drag: DragState | null,
  inpaintState: InpaintState | null,
  changeMaskCanvas: HTMLCanvasElement | null,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const bufW = canvas.width
  const bufH = canvas.height
  ctx.clearRect(0, 0, bufW, bufH)

  const cssRect = canvas.getBoundingClientRect()
  const layout = computeObjectContainLayout(cssRect.width, cssRect.height, imgW, imgH)

  // Faint image-boundary guide — always visible.
  const imageBounds: ImageRect = { x: 0, y: 0, w: imgW, h: imgH }
  drawImageRect(ctx, imageBounds, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,0.4)',
    lineWidth: 1.5,
    dash: [6, 4],
  })

  if (!drag) return

  // Prefer the committed region; fall back to the in-progress drag.
  const currentSelect =
    inpaintState?.region.selectionRect ?? selectionFromDrag(drag, imageBounds)

  if (currentSelect.w < 2 || currentSelect.h < 2) return

  // Context strip around the selection.
  const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, imageBounds)
  drawImageRect(ctx, currentStrip, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(60,140,255,0.18)',
    lineWidth: 6,
  })
  drawImageLabel(ctx, currentStrip, layout, bufW, bufH, 'Context')

  // Selection rectangle.
  drawImageRect(ctx, currentSelect, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(30,100,220,0.22)',
    lineWidth: 6,
  })
  drawImageLabel(ctx, currentSelect, layout, bufW, bufH, 'Selection')

  // Tile grid overlay (visible during tiling / done phase).
  if (
    inpaintState &&
    (inpaintState.phase === 'tiling' || inpaintState.phase === 'done') &&
    inpaintState.tilePlan
  ) {
    const { tilePlan, tileResults, generatingTileIdx } = inpaintState
    const { contextRect } = inpaintState.region

    // ── Change mask: blue-tinted diff overlay at context rect position ────────
    // Build a tinted canvas from the diff mask and paint it over the image area.
    if (changeMaskCanvas) {
      const bufContext = imageRectToBuffer(contextRect, layout, bufW, bufH)
      const cX = Math.round(bufContext.x)
      const cY = Math.round(bufContext.y)
      const cW = Math.max(1, Math.round(bufContext.w))
      const cH = Math.max(1, Math.round(bufContext.h))

      const tintCanvas = document.createElement('canvas')
      tintCanvas.width  = cW
      tintCanvas.height = cH
      const tintCtx = tintCanvas.getContext('2d')
      if (tintCtx) {
        tintCtx.fillStyle = '#1e8cff'
        tintCtx.fillRect(0, 0, cW, cH)
        tintCtx.globalCompositeOperation = 'destination-in'
        tintCtx.drawImage(changeMaskCanvas, 0, 0, cW, cH)
      }
      ctx.globalAlpha = 0.35
      ctx.drawImage(tintCanvas, cX, cY)
      ctx.globalAlpha = 1
    }

    for (let i = 0; i < tilePlan.tiles.length; i++) {
      const tile = tilePlan.tiles[i]
      const isGenerating = generatingTileIdx === i
      const isDone       = tileResults[i] !== null
      const hasMask      = tile.maskSubRect !== null

      const tileRect: ImageRect = {
        x: contextRect.x + tile.x,
        y: contextRect.y + tile.y,
        w: tile.w,
        h: tile.h,
      }

      // ── Tile boundary ───────────────────────────────────────────────────────
      if (hasMask) {
        // Masked tile — colour by status.
        let strokeStyle = 'rgba(255,255,255,0.5)'
        let fillStyle: string | undefined
        if (isGenerating) {
          strokeStyle = 'rgba(60,140,255,0.9)'
          fillStyle   = 'rgba(60,140,255,0.08)'
        } else if (isDone) {
          strokeStyle = 'rgba(40,200,80,0.8)'
          fillStyle   = 'rgba(40,200,80,0.06)'
        }
        drawImageRect(ctx, tileRect, layout, bufW, bufH, {
          strokeStyle,
          fillStyle,
          lineWidth: 2,
          dash: isDone || isGenerating ? [] : [4, 3],
        })
      } else {
        // Pure-context tile — dim ghost outline only.
        drawImageRect(ctx, tileRect, layout, bufW, bufH, {
          strokeStyle: 'rgba(255,255,255,0.15)',
          lineWidth: 1,
          dash: [3, 5],
        })
      }

      // ── maskSubRect and context ring (only for masked tiles, pre-done) ─────
      if (hasMask && tile.maskSubRect && !isDone) {
        const ms = tile.maskSubRect
        const maskRect: ImageRect = {
          x: contextRect.x + tile.x + ms.x,
          y: contextRect.y + tile.y + ms.y,
          w: ms.w,
          h: ms.h,
        }

        // Context ring: the part of the tile outside maskSubRect.
        // Visualised as a cool blue tint — shows what the model sees as
        // "source pixels" (high-res, unchanged).
        drawImageRect(ctx, tileRect, layout, bufW, bufH, {
          strokeStyle: 'transparent',
          fillStyle: isGenerating ? 'rgba(60,140,255,0.12)' : 'rgba(100,160,255,0.1)',
          lineWidth: 0,
        })

        // Plan zone: the maskSubRect — this is where blurry plan pixels are
        // baked in and the model must sharpen them.
        drawImageRect(ctx, maskRect, layout, bufW, bufH, {
          strokeStyle: isGenerating ? 'rgba(60,140,255,0.9)' : 'rgba(255,180,40,0.9)',
          fillStyle:   isGenerating ? 'rgba(60,140,255,0.18)' : 'rgba(255,180,40,0.18)',
          lineWidth: 1.5,
        })

        // Labels inside the plan zone and in the context ring.
        drawImageLabel(ctx, maskRect, layout, bufW, bufH, 'Plan')

        // Context ring label: place it at the top-left corner of the tile
        // (which is guaranteed to be outside maskSubRect when the ring exists).
        if (ms.x > 4 || ms.y > 4) {
          const ringLabelRect: ImageRect = {
            x: contextRect.x + tile.x,
            y: contextRect.y + tile.y,
            w: Math.max(ms.x, 24),
            h: Math.max(ms.y, 24),
          }
          drawImageLabel(ctx, ringLabelRect, layout, bufW, bufH, 'Source')
        }
      }
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
 * Renders the source image with a transparent canvas overlay for interactive
 * selection drawing. Once the user commits a selection the sidebar transitions
 * to the input form. On submit:
 *
 *   1. Generate → buildGlobalPlanInput → /api/edit 'plan'    → globalPlanUrl
 *   2.          → computeChangeMask (client-side pixel diff, no LLM call)
 *   3.          → buildGlobalInpaintComposite: ONE full-resolution canvas —
 *                 crisp source everywhere, softened/feathered plan content
 *                 baked into actually-changed pixels. Not clipped to the
 *                 selection rectangle — the change mask alone decides what
 *                 shows plan content, so legitimate bleed into the context
 *                 band (e.g. a shadow/highlight) is kept rather than discarded.
 *   Fast path (context ≤ MAX_AI_DIMENSION): the composite above IS the final
 *     result — no refine pass needed, jump straight to phase 'done'.
 *   Full path (context > MAX_AI_DIMENSION):
 *   3a.         → planInpaintTiles (phase → 'tiling', idle)
 *   4. Per tile (manual): cropInpaintTileInput (plain crop from the shared
 *        running canvas — already-sharpened neighbour tiles show through
 *        automatically) → /api/edit 'refine' → compositeInpaintTileResult
 *        (stamps the whole tile, same no-clip rule) (generateTile / Generate-all)
 *   5. Accept → compositeInpaintFinal → onAccept
 *
 * Re-run controls exist for the plan (cascades to mask/tiles), the mask
 * (reuses the plan), and each tile individually (full path only).
 */
const SIDEBAR_W = 360

/** Response shape for any /api/edit phase that returns a generated image URL. */
type EditPhaseResponse = { resultUrl?: string; error?: string }

/**
 * Stage 1 — global plan. Builds the annotated plan input, calls the LLM 'plan'
 * phase, and returns the plan URL plus the context→plan-pixel scale factor.
 */
async function runGlobalPlanStage(args: {
  image: string
  region: InpaintRegion
  editPrompt: string
  referenceImages: ReferenceImage[]
  apiKey: string
  model: string
}): Promise<{ globalPlanUrl: string; globalPlanScale: number }> {
  const { dataUrl, scale } = await buildGlobalPlanInput(
    args.image,
    args.region.contextRect,
    args.region.selectionRect,
  )
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 'plan',
      imageDataUrl: dataUrl,
      editPrompt: args.editPrompt,
      referenceImages: args.referenceImages,
      apiKey: args.apiKey,
      model: args.model,
    }),
  })
  const data = (await res.json()) as EditPhaseResponse
  if (!res.ok || !data.resultUrl) {
    throw new Error(data.error ?? 'Planning failed')
  }
  return { globalPlanUrl: data.resultUrl, globalPlanScale: scale }
}

/**
 * Stage 2 (removed) — change-mask extraction was replaced by the client-side
 * computeChangeMask pixel diff. This function is no longer called.
 * Kept as a tombstone to document the removal; delete after next cleanup pass.
 */

/**
 * Stage 3 — tiling setup. Builds the shared running composite canvas (crisp
 * source everywhere, softened global-plan content baked into the actually-
 * changed selection pixels — see `buildGlobalInpaintComposite`) and the tile
 * plan. Tiles are NOT generated here; each is run on demand by the user,
 * cropping directly from this canvas.
 */
async function buildTilingSetup(
  image: string,
  region: InpaintRegion,
  globalPlanUrl: string,
  globalPlanScale: number,
  changeMask: HTMLCanvasElement | null,
): Promise<{ canvas: HTMLCanvasElement; tilePlan: InpaintTilePlan }> {
  const canvas = await buildGlobalInpaintComposite(
    image,
    region.contextRect,
    globalPlanUrl,
    globalPlanScale,
    changeMask,
  )
  const selInCtx = {
    x: region.selectionRect.x - region.contextRect.x,
    y: region.selectionRect.y - region.contextRect.y,
    w: region.selectionRect.w,
    h: region.selectionRect.h,
  }
  const tilePlan = planInpaintTiles(region.contextRect.w, region.contextRect.h, selInCtx)
  return { canvas, tilePlan }
}

export function EditStudio({ image, dimensions, onPickFile, onDropFile, apiKey, model, onAccept }: EditStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDraggingRef = useRef(false)
  /** Running composite surface for the tiled inpaint pass. */
  const inpaintCanvasRef = useRef<HTMLCanvasElement | null>(null)
  /** Client-computed pixel-diff change mask (computeChangeMask result). */
  const changeMaskCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [drag, setDrag] = useState<DragState | null>(null)
  const [inpaintState, setInpaintState] = useState<InpaintState | null>(null)
  /** Bumped when the displayed image size changes so the overlay stays aligned. */
  const [layoutTick, setLayoutTick] = useState(0)

  // ── Sync canvas buffer to natural image dimensions ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  // ── Redraw overlay when the fitted image resizes (window / sidebar layout) ─
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [dimensions, image])

  // ── Redraw overlay on drag or inpaint state changes ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) return
    renderOverlay(canvas, dimensions.width, dimensions.height, drag, inpaintState, changeMaskCanvasRef.current)
  }, [drag, dimensions, inpaintState, layoutTick])

  // ── Build low-res context crop + annotated preview when selection commits ────
  useEffect(() => {
    if (!drag?.committed || !image || !dimensions) return

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = selectionFromDrag(drag, imageBounds)
    if (sel.w < 1 || sel.h < 1) return

    const contextRect = outsetRect(sel, EDIT_STRIP_PX, imageBounds)

    buildLowResContextCrop(image, contextRect).then(({ dataUrl }) => {
      // Annotated preview: draw the selection box on top of the clean crop.
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
          // Map through the crop's actual output size (handles rounding in buildLowResContextCrop).
          const scaleX = img.naturalWidth / contextRect.w
          const scaleY = img.naturalHeight / contextRect.h
          const lrX = selInCtx.x * scaleX
          const lrY = selInCtx.y * scaleY
          const lrW = selInCtx.w * scaleX
          const lrH = selInCtx.h * scaleY
          ctx.fillStyle = 'rgba(30,100,220,0.18)'
          ctx.fillRect(lrX, lrY, lrW, lrH)
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = Math.max(1.5, Math.min(scaleX, scaleY) * 2)
          ctx.strokeRect(lrX, lrY, lrW, lrH)
        }
        const previewUrl = canvas.toDataURL('image/jpeg', 0.92)
        setInpaintState((prev) =>
          prev ? { ...prev, lowResContextUrl: dataUrl, lowResPreviewUrl: previewUrl } : null,
        )
      }
      img.src = dataUrl
    }).catch(() => {})
  }, [drag, image, dimensions])

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dimensions) return
      const canvas = canvasRef.current
      if (!canvas) return
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
      const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }

      setDrag((prev) => {
        if (!prev) return null
        const sel = selectionFromDrag({ ...prev, current: pt }, imageBounds)
        if (sel.w < 8 || sel.h < 8) return null
        return committedDragFromSelection({ ...prev, current: pt }, sel)
      })
    },
    [dimensions],
  )

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false
      setDrag((prev) => {
        if (!prev || !dimensions) return null
        const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
        const sel = selectionFromDrag(prev, imageBounds)
        if (sel.w < 8 || sel.h < 8) return null
        return committedDragFromSelection(prev, sel)
      })
    }
  }, [dimensions])

  // ── Initialise InpaintState when drag commits ──────────────────────────────
  useEffect(() => {
    if (!drag?.committed || !dimensions || inpaintState) return

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = selectionFromDrag(drag, imageBounds)
    if (sel.w < 1 || sel.h < 1) return

    const contextRect = outsetRect(sel, EDIT_STRIP_PX, imageBounds)

    const region: InpaintRegion = {
      selectionRect: sel,
      contextRect,
    }

    setInpaintState({
      phase: 'input',
      region,
      editPrompt: '',
      referenceImages: [],
      lowResContextUrl: null,
      lowResPreviewUrl: null,
      globalPlanScale: 1,
      globalPlanUrl: null,
      changeMaskUrl: null,
      changeMaskOverlayUrl: null,
      tilePlan: null,
      tileResults: [],
      generatingTileIdx: null,
      error: null,
    })
  }, [drag, dimensions, inpaintState])

  // ── Callback: user submits description — kick off the full pipeline ─────────

  /**
   * Run the global plan, then — if the context fits within MAX_AI_DIMENSION —
   * composite the plan directly and jump to 'done' (fast path). Otherwise
   * compute the change mask client-side via pixel diff and set up tiling.
   * No LLM mask-extraction call is made in either path.
   */
  const runPlanAndMask = useCallback(
    async (editPrompt: string, referenceImages: ReferenceImage[], region: InpaintRegion, lowResContextUrl: string | null) => {
      try {
        const { globalPlanUrl, globalPlanScale } = await runGlobalPlanStage({
          image: image ?? '',
          region,
          editPrompt,
          referenceImages,
          apiKey,
          model,
        })
        setInpaintState((prev) =>
          prev ? { ...prev, globalPlanUrl, globalPlanScale, phase: 'tiling' } : null,
        )

        const { contextRect } = region

        // Change mask — client-side pixel diff between the original low-res
        // context and the plan result. Threshold 10 absorbs JPEG compression
        // noise in the plan without masking real edits. Computed for both the
        // fast and full paths now, since both rely on it (via
        // buildGlobalInpaintComposite) to decide which pixels show plan
        // content — there is no selection-rectangle clip anywhere in this
        // pipeline; the mask alone is the authority.
        if (lowResContextUrl) {
          changeMaskCanvasRef.current = await computeChangeMask(lowResContextUrl, globalPlanUrl, 10)
        } else {
          changeMaskCanvasRef.current = null
        }

        // Build display-only visualisations of the mask (B&W + blue overlay)
        // and store them in state so the sidebar and canvas overlay can render them.
        let changeMaskUrl: string | null = null
        let changeMaskOverlayUrl: string | null = null
        if (changeMaskCanvasRef.current) {
          const visuals = await buildChangeMaskVisuals(changeMaskCanvasRef.current, globalPlanUrl)
          changeMaskUrl = visuals.maskUrl
          changeMaskOverlayUrl = visuals.overlayUrl
        }

        // Fast path — context fits in a single tile, so there's no refine
        // pass: the mask-blended composite below IS the final result.
        if (contextRect.w <= MAX_AI_DIMENSION && contextRect.h <= MAX_AI_DIMENSION) {
          const canvas = await buildGlobalInpaintComposite(
            image ?? '',
            contextRect,
            globalPlanUrl,
            globalPlanScale,
            changeMaskCanvasRef.current,
          )
          inpaintCanvasRef.current = canvas
          setInpaintState((prev) =>
            prev
              ? {
                  ...prev,
                  changeMaskUrl,
                  changeMaskOverlayUrl,
                  phase: 'done',
                  tilePlan: null,
                  tileResults: [],
                  generatingTileIdx: null,
                }
              : null,
          )
          return
        }

        // Full path — set up tiles over the same mask-blended composite.
        const { canvas, tilePlan } = await buildTilingSetup(
          image ?? '',
          region,
          globalPlanUrl,
          globalPlanScale,
          changeMaskCanvasRef.current,
        )
        inpaintCanvasRef.current = canvas

        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                changeMaskUrl,
                changeMaskOverlayUrl,
                phase: 'tiling',
                tilePlan,
                tileResults: Array<string | null>(tilePlan.tiles.length).fill(null),
                generatingTileIdx: null,
              }
            : null,
        )
      } catch (e) {
        setInpaintState((prev) =>
          prev
            ? { ...prev, phase: 'input', error: e instanceof Error ? e.message : 'Generation failed', generatingTileIdx: null }
            : null,
        )
      }
    },
    [image, apiKey, model],
  )

  // ── Callback: submit description — run plan + mask (tiles stay manual) ──────

  const handleGenerate = useCallback(
    async (editPrompt: string, referenceImages: ReferenceImage[]) => {
      if (!inpaintState || !image) return
      const { region, lowResContextUrl } = inpaintState

      inpaintCanvasRef.current = null
      setInpaintState((prev) =>
        prev ? { ...prev, phase: 'planning', editPrompt, referenceImages, error: null } : null,
      )

      await runPlanAndMask(editPrompt, referenceImages, region, lowResContextUrl)
    },
    [inpaintState, image, runPlanAndMask],
  )

  // ── Callback: re-run the global plan (cascades to tiling, resets tiles) ─────
  // The description can be edited in the sidebar after the initial generation,
  // so this always re-runs with whatever text is currently in the panel
  // (falling back to the last-submitted description if it was cleared).

  const handleRerunPlan = useCallback(async (editPrompt: string) => {
    if (!inpaintState || !image) return
    const { region, referenceImages, lowResContextUrl } = inpaintState
    const nextEditPrompt = editPrompt.trim() || inpaintState.editPrompt

    inpaintCanvasRef.current = null
    changeMaskCanvasRef.current = null
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'planning',
            editPrompt: nextEditPrompt,
            error: null,
            globalPlanUrl: null,
            changeMaskUrl: null,
            changeMaskOverlayUrl: null,
            tilePlan: null,
            tileResults: [],
            generatingTileIdx: null,
          }
        : null,
    )

    await runPlanAndMask(nextEditPrompt, referenceImages, region, lowResContextUrl)
  }, [inpaintState, image, runPlanAndMask])

  // ── Callback: generate / re-run a single tile ──────────────────────────────
  // This is the ONLY path that produces tile pixels — tiles never run
  // automatically. Used by the per-tile buttons and by "Generate all".

  const generateTile = useCallback(
    async (idx: number) => {
      const canvas = inpaintCanvasRef.current
      if (!inpaintState || !image || !inpaintState.tilePlan || !inpaintState.globalPlanUrl || !canvas) return

      const tile = inpaintState.tilePlan.tiles[idx]
      if (!tile.maskSubRect) return

      const { contextRect } = inpaintState.region
      const { editPrompt } = inpaintState

      setInpaintState((prev) => (prev ? { ...prev, generatingTileIdx: idx, error: null } : null))

      try {
        // Plain crop from the shared running canvas — it already contains the
        // softened global-plan content baked into changed selection pixels,
        // plus the sharpened output of any already-processed neighbour tiles.
        // Mirrors the extend pipeline's crop-from-band-canvas approach.
        const tileInputUrl = cropInpaintTileInput(canvas, tile)

        // Reference images are intentionally omitted here — they steer the
        // global plan's style/composition, but a tile only needs to sharpen
        // the blurry plan crop it was given. Re-sending them risks pulling
        // the tile back toward the global brief instead of local fidelity.
        const tileRes = await fetch('/api/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'refine',
            imageDataUrl: tileInputUrl,
            editPrompt,
            tileIndex: tile.row * tile.totalCols + tile.col + 1,
            tileCount: tile.totalRows * tile.totalCols,
            apiKey,
            model,
          }),
        })
        const tileData = await tileRes.json() as { resultUrl?: string; error?: string }
        if (!tileRes.ok || !tileData.resultUrl) throw new Error(tileData.error ?? 'Tile refinement failed')

        await compositeInpaintTileResult(canvas, image, tileData.resultUrl, tile, contextRect)

        const resultUrl = tileData.resultUrl
        setInpaintState((prev) => {
          if (!prev) return null
          const tileResults = [...prev.tileResults]
          tileResults[idx] = resultUrl
          return { ...prev, tileResults, generatingTileIdx: null }
        })
      } catch (e) {
        setInpaintState((prev) =>
          prev
            ? { ...prev, generatingTileIdx: null, error: e instanceof Error ? e.message : 'Tile failed' }
            : null,
        )
      }
    },
    [inpaintState, image, apiKey, model],
  )

  // ── Callback: generate every masked tile that hasn't been generated yet ─────

  const handleGenerateAllTiles = useCallback(async () => {
    const plan = inpaintState?.tilePlan
    if (!plan) return
    const pending = plan.tiles
      .map((tile, idx) => ({ tile, idx }))
      .filter(({ tile, idx }) => tile.maskSubRect !== null && (inpaintState?.tileResults[idx] ?? null) === null)
      .map(({ idx }) => idx)

    for (const idx of pending) {
      await generateTile(idx)
    }
  }, [inpaintState, generateTile])

  // ── Callback: re-run the whole pipeline (back to input phase) ──────────────

  const handleRerun = useCallback(() => {
    inpaintCanvasRef.current = null
    changeMaskCanvasRef.current = null
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'input',
            globalPlanUrl: null,
            changeMaskUrl: null,
            changeMaskOverlayUrl: null,
            tilePlan: null,
            tileResults: [],
            generatingTileIdx: null,
            error: null,
          }
        : null,
    )
  }, [])

  // ── Callback: accept — stamp inpaint canvas into full image ────────────────

  const handleAccept = useCallback(async () => {
    const inpaintCanvas = inpaintCanvasRef.current

    if (!inpaintCanvas) {
      console.warn('[EditStudio] handleAccept: inpaintCanvas is null')
      setInpaintState((prev) =>
        prev ? { ...prev, error: 'Cannot accept: inpaint canvas is missing. Please try regenerating.' } : null,
      )
      return
    }
    if (!image) {
      console.warn('[EditStudio] handleAccept: image prop is null/empty')
      setInpaintState((prev) =>
        prev ? { ...prev, error: 'Cannot accept: source image is missing.' } : null,
      )
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
        phase: inpaintState.phase,
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

      if (isSameAsSource) {
        // The compositeInpaintFinal helper fell back to returning the source URL
        // unchanged — this means canvas.getContext('2d') returned null.
        setInpaintState((prev) =>
          prev ? { ...prev, error: 'Compositing failed: could not get canvas context. Try reloading the page.' } : null,
        )
        return
      }

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

  // ── Callback: close panel — clear everything ───────────────────────────────

  const handleClose = useCallback(() => {
    inpaintCanvasRef.current = null
    changeMaskCanvasRef.current = null
    setInpaintState(null)
    setDrag(null)
  }, [])

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!image || !dimensions) {
    return <EmptyEditState onPickFile={onPickFile} onDropFile={onDropFile} />
  }

  const isProcessing =
    inpaintState?.phase === 'planning' ||
    inpaintState?.phase === 'tiling'

  const hasSelection = !!drag?.committed || !!inpaintState

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* ── Image area ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 pt-2 min-w-0 min-h-0">
        <div className="relative anim-fade flex min-h-0 w-full flex-1 flex-col min-w-0">
          <div
            className="relative min-h-0 w-full flex-1 overflow-hidden checker rounded-[var(--radius-lg)]"
            style={{
              border: '1px solid var(--border)',
              boxShadow:
                '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
            }}
          >
            <img
              src={image}
              alt=""
              className="block h-full w-full object-contain anim-fade"
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

          {/* Below-image meta row */}
          <div className="mt-4 flex h-7 items-center gap-3">
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
            {drag && !drag.committed && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Release to confirm selection
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div
        className="flex min-h-0 flex-col"
        style={{
          width: SIDEBAR_W,
          flexShrink: 0,
          maxHeight: '100vh',
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
      >
        {/* Sidebar header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Edit
          </span>
          <div className="flex items-center gap-2">
            {!hasSelection && image && (
              <button
                className="btn btn-ghost text-[12px]"
                style={{ padding: '2px 10px', height: 28 }}
                onClick={() => {
                  const link = document.createElement('a')
                  link.href = image
                  link.download = `edited_${timestampForFilename()}.png`
                  document.body.appendChild(link)
                  link.click()
                  document.body.removeChild(link)
                }}
              >
                <Icons.Download size={12} />
                Save
              </button>
            )}
            {hasSelection && (
              <button
                className="btn btn-ghost text-[12px]"
                style={{ padding: '2px 10px', height: 28 }}
                onClick={handleClose}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Sidebar body */}
        {inpaintState ? (
          <EditPanel
            inpaintState={inpaintState}
            onGenerate={(prompt, refs) => { void handleGenerate(prompt, refs) }}
            onRerunPlan={(editPrompt) => { void handleRerunPlan(editPrompt) }}
            onRerunTile={(idx) => { void generateTile(idx) }}
            onGenerateAllTiles={() => { void handleGenerateAllTiles() }}
            onRerun={handleRerun}
            onAccept={() => { void handleAccept() }}
            onClose={handleClose}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.Pencil size={20} className="opacity-40" />
            </div>
            <div>
              <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                Make a selection
              </p>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Click and drag on the image to select the area you want to edit.
              </p>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
