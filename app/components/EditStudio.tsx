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
  buildMaskOverlay,
  planInpaintTiles,
  initInpaintCanvas,
  buildInpaintTileInput,
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
 * Minimal Promise-based image loader used by the direct-plan fast path.
 * Avoids importing the private `loadImageElement` from imageProcessor.
 */
function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = url
  })
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
 * Flips below the top edge when the rectangle is near the canvas top.
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
 * Render the selection overlay and (during tiling) the tile grid onto the
 * overlay canvas.
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

  // Faint image-boundary guide — always visible.
  const imageBounds: ImageRect = { x: 0, y: 0, w: imgW, h: imgH }
  drawRect(ctx, imageBounds, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,0.4)',
    lineWidth: 1.5,
    dash: [6, 4],
  })

  if (!drag) return

  // The selection is clamped to the full image bounds (no artificial size cap).
  const rawSelect = normaliseRect(drag.start, drag.current)
  const currentSelect = clampRect(rawSelect, imageBounds)

  if (currentSelect.w < 2 || currentSelect.h < 2) return

  // Context strip around the selection.
  const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, imageBounds)
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

  // Tile grid overlay (visible during tiling / done phase).
  if (
    inpaintState &&
    (inpaintState.phase === 'tiling' || inpaintState.phase === 'done') &&
    inpaintState.tilePlan
  ) {
    const { tilePlan, tileResults, generatingTileIdx } = inpaintState
    const { contextRect } = inpaintState.region

    for (let i = 0; i < tilePlan.tiles.length; i++) {
      const tile = tilePlan.tiles[i]
      if (!tile.maskSubRect) continue

      const isGenerating = generatingTileIdx === i
      const isDone = tileResults[i] !== null

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
 * Renders the source image with a transparent canvas overlay for interactive
 * selection drawing. Once the user commits a selection the sidebar transitions
 * to the input form. On submit, only the plan runs automatically. If the
 * context rect fits within MAX_AI_DIMENSION the plan result is composited
 * directly and the user can accept immediately (fast path). Otherwise the mask
 * and tile steps follow:
 *
 *   1. Generate → buildGlobalPlanInput → /api/edit 'plan'        → globalPlanUrl
 *   Fast path (context ≤ MAX_AI_DIMENSION):
 *   1a.         → draw globalPlanUrl into inpaint canvas → phase 'done'
 *   Full path:
 *   2.          → /api/edit 'extract-mask' → globalMaskUrl → buildMaskOverlay
 *   3.          → planInpaintTiles + initInpaintCanvas (phase → 'tiling', idle)
 *   4. Per tile (manual): buildInpaintTileInput → /api/edit 'refine'
 *        → compositeInpaintTileResult   (generateTile / Generate-all)
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
 * Stage 2 — change-mask extraction. Calls the LLM 'extract-mask' phase with the
 * clean context crop and the plan, then builds the display-only overlay.
 */
async function runChangeMaskStage(args: {
  lowResContextUrl: string | null
  globalPlanUrl: string
  apiKey: string
  model: string
}): Promise<{ globalMaskUrl: string; globalMaskOverlayUrl: string | null }> {
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 'extract-mask',
      sourceContextUrl: args.lowResContextUrl,
      globalPlanUrl: args.globalPlanUrl,
      apiKey: args.apiKey,
      model: args.model,
    }),
  })
  const data = (await res.json()) as EditPhaseResponse
  if (!res.ok || !data.resultUrl) {
    throw new Error(data.error ?? 'Mask extraction failed')
  }
  const overlay = await buildMaskOverlay(args.globalPlanUrl, data.resultUrl).catch(() => null)
  return { globalMaskUrl: data.resultUrl, globalMaskOverlayUrl: overlay ?? null }
}

/**
 * Stage 3 — tiling setup. Builds the running composite canvas (pre-filled with
 * source) and the tile plan. Tiles are NOT generated here; each is run on
 * demand by the user.
 */
async function buildTilingSetup(
  image: string,
  region: InpaintRegion,
): Promise<{ canvas: HTMLCanvasElement; tilePlan: InpaintTilePlan }> {
  const canvas = await initInpaintCanvas(image, region.contextRect)
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

  const [drag, setDrag] = useState<DragState | null>(null)
  const [inpaintState, setInpaintState] = useState<InpaintState | null>(null)

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

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = clampRect(normaliseRect(drag.start, drag.current), imageBounds)
    if (sel.w < 1 || sel.h < 1) return

    const contextRect = outsetRect(sel, EDIT_STRIP_PX, imageBounds)

    buildLowResContextCrop(image, contextRect).then(({ dataUrl, scale }) => {
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

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = clampRect(normaliseRect(drag.start, drag.current), imageBounds)
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
      globalMaskUrl: null,
      globalMaskOverlayUrl: null,
      tilePlan: null,
      tileResults: [],
      generatingTileIdx: null,
      error: null,
    })
  }, [drag, dimensions, inpaintState])

  // ── Callback: user submits description — kick off the full pipeline ─────────

  /**
   * Run the global plan, then — if the context fits within MAX_AI_DIMENSION —
   * composite the plan directly and jump to 'done' (fast path). Otherwise run
   * the change mask and set up tiling. Shared by the initial Generate action
   * and the "re-run plan" action. Tiles are NOT generated here in either path;
   * the user runs each one manually afterward (full path only).
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
          prev ? { ...prev, globalPlanUrl, globalPlanScale, phase: 'masking' } : null,
        )

        const { contextRect } = region

        // Fast path — context fits in a single tile. Skip mask extraction and
        // tiling: draw the plan result directly into the inpaint canvas so the
        // user can accept immediately without any further LLM calls.
        if (contextRect.w <= MAX_AI_DIMENSION && contextRect.h <= MAX_AI_DIMENSION) {
          const canvas = await initInpaintCanvas(image ?? '', contextRect)
          const planImg = await loadImg(globalPlanUrl)
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(planImg, 0, 0, canvas.width, canvas.height)
          }
          inpaintCanvasRef.current = canvas
          setInpaintState((prev) =>
            prev
              ? {
                  ...prev,
                  phase: 'done',
                  tilePlan: null,
                  tileResults: [],
                  generatingTileIdx: null,
                }
              : null,
          )
          return
        }

        // Full path — context is too large for a single tile; run mask + tiles.
        const { globalMaskUrl, globalMaskOverlayUrl } = await runChangeMaskStage({
          lowResContextUrl,
          globalPlanUrl,
          apiKey,
          model,
        })

        const { canvas, tilePlan } = await buildTilingSetup(image ?? '', region)
        inpaintCanvasRef.current = canvas

        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                globalMaskUrl,
                globalMaskOverlayUrl,
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

  // ── Callback: re-run the global plan (cascades to mask, resets tiles) ───────

  const handleRerunPlan = useCallback(async () => {
    if (!inpaintState || !image) return
    const { region, editPrompt, referenceImages, lowResContextUrl } = inpaintState

    inpaintCanvasRef.current = null
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'planning',
            error: null,
            globalPlanUrl: null,
            globalMaskUrl: null,
            globalMaskOverlayUrl: null,
            tilePlan: null,
            tileResults: [],
            generatingTileIdx: null,
          }
        : null,
    )

    await runPlanAndMask(editPrompt, referenceImages, region, lowResContextUrl)
  }, [inpaintState, image, runPlanAndMask])

  // ── Callback: re-run only the change mask (reuses the existing plan) ────────

  const handleRerunMask = useCallback(async () => {
    if (!inpaintState || !image || !inpaintState.globalPlanUrl) return
    const { region, globalPlanUrl, lowResContextUrl } = inpaintState

    inpaintCanvasRef.current = null
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'masking',
            error: null,
            globalMaskUrl: null,
            globalMaskOverlayUrl: null,
            tilePlan: null,
            tileResults: [],
            generatingTileIdx: null,
          }
        : null,
    )

    try {
      const { globalMaskUrl, globalMaskOverlayUrl } = await runChangeMaskStage({
        lowResContextUrl,
        globalPlanUrl,
        apiKey,
        model,
      })

      const { canvas, tilePlan } = await buildTilingSetup(image, region)
      inpaintCanvasRef.current = canvas

      setInpaintState((prev) =>
        prev
          ? {
              ...prev,
              globalMaskUrl,
              globalMaskOverlayUrl,
              phase: 'tiling',
              tilePlan,
              tileResults: Array<string | null>(tilePlan.tiles.length).fill(null),
              generatingTileIdx: null,
            }
          : null,
      )
    } catch (e) {
      setInpaintState((prev) =>
        prev ? { ...prev, phase: 'tiling', error: e instanceof Error ? e.message : 'Mask extraction failed' } : null,
      )
    }
  }, [inpaintState, image, apiKey, model])

  // ── Callback: generate / re-run a single tile ──────────────────────────────
  // This is the ONLY path that produces tile pixels — tiles never run
  // automatically. Used by the per-tile buttons and by "Generate all".

  const generateTile = useCallback(
    async (idx: number) => {
      const canvas = inpaintCanvasRef.current
      if (!inpaintState || !image || !inpaintState.tilePlan || !inpaintState.globalPlanUrl || !inpaintState.globalMaskUrl || !canvas) return

      const tile = inpaintState.tilePlan.tiles[idx]
      if (!tile.maskSubRect) return

      const { contextRect } = inpaintState.region
      const { editPrompt, referenceImages, globalPlanUrl, globalMaskUrl, globalPlanScale } = inpaintState

      setInpaintState((prev) => (prev ? { ...prev, generatingTileIdx: idx, error: null } : null))

      try {
        const tileInputUrl = await buildInpaintTileInput(
          image,
          contextRect,
          tile,
          globalPlanUrl,
          globalPlanScale,
          globalMaskUrl,
        )

        const tileRes = await fetch('/api/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'refine',
            imageDataUrl: tileInputUrl,
            editPrompt,
            referenceImages,
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
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'input',
            globalPlanUrl: null,
            globalMaskUrl: null,
            globalMaskOverlayUrl: null,
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
    setInpaintState(null)
    setDrag(null)
  }, [])

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!image || !dimensions) {
    return <EmptyEditState onPickFile={onPickFile} onDropFile={onDropFile} />
  }

  const isProcessing =
    inpaintState?.phase === 'planning' ||
    inpaintState?.phase === 'masking' ||
    inpaintState?.phase === 'tiling'

  const hasSelection = !!drag?.committed || !!inpaintState

  return (
    <div className="flex flex-1 overflow-hidden">

      {/* ── Image area ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 pt-2">
        <div className="relative anim-fade">
          <div
            className="relative overflow-hidden checker rounded-[var(--radius-lg)]"
            style={{
              border: '1px solid var(--border)',
              boxShadow:
                '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
            }}
          >
            <img
              src={image}
              alt=""
              className="block object-contain anim-fade"
              style={{
                maxHeight: 'calc(100vh - 200px)',
                maxWidth: `min(900px, calc(100vw - ${SIDEBAR_W + 64}px))`,
              }}
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

        {/* Sidebar body */}
        {inpaintState ? (
          <EditPanel
            inpaintState={inpaintState}
            onGenerate={(prompt, refs) => { void handleGenerate(prompt, refs) }}
            onRerunPlan={() => { void handleRerunPlan() }}
            onRerunMask={() => { void handleRerunMask() }}
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
