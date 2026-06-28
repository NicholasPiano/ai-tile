'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { EDIT_STRIP_PX, MAX_EDIT_SELECTION_PX } from '@/app/lib/app'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A point in image-pixel space. */
type ImagePoint = { x: number; y: number }

/** An axis-aligned rectangle in image-pixel space. */
type ImageRect = { x: number; y: number; w: number; h: number }

/**
 * Active drag state. `start` and `current` are in image-pixel coordinates.
 * The component treats the rect as canonical in that coordinate system and
 * only projects to canvas pixels when drawing.
 */
type DragState = {
  start: ImagePoint
  current: ImagePoint
  committed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp `value` to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Convert a MouseEvent's client coordinates into image-pixel coordinates.
 * The canvas element is positioned and sized to match the displayed image, so
 * we map client coords → canvas-local coords → image pixels.
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

/**
 * Return the normalised (positive-width, positive-height) rectangle from two
 * arbitrary corner points.
 */
function normaliseRect(a: ImagePoint, b: ImagePoint): ImageRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/**
 * Inset a rectangle by `amount` pixels on every side.
 * Returns null when the resulting rectangle would have zero or negative extent.
 */
function insetRect(r: ImageRect, amount: number): ImageRect | null {
  const x = r.x + amount
  const y = r.y + amount
  const w = r.w - amount * 2
  const h = r.h - amount * 2
  if (w <= 0 || h <= 0) {
    return null
  }
  return { x, y, w, h }
}

/**
 * Outset a rectangle by `amount` pixels on every side, clamped so it never
 * exceeds the bounds of `container`.
 */
function outsetRect(r: ImageRect, amount: number, container: ImageRect): ImageRect {
  return {
    x: Math.max(container.x, r.x - amount),
    y: Math.max(container.y, r.y - amount),
    w: Math.min(container.x + container.w, r.x + r.w + amount) - Math.max(container.x, r.x - amount),
    h: Math.min(container.y + container.h, r.y + r.h + amount) - Math.max(container.y, r.y - amount),
  }
}

/**
 * Clamp a rectangle so it fits entirely within `bounds`.
 */
function clampRect(r: ImageRect, bounds: ImageRect): ImageRect {
  const x = clamp(r.x, bounds.x, bounds.x + bounds.w)
  const y = clamp(r.y, bounds.y, bounds.y + bounds.h)
  const x2 = clamp(r.x + r.w, bounds.x, bounds.x + bounds.w)
  const y2 = clamp(r.y + r.h, bounds.y, bounds.y + bounds.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection constraint helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the largest rectangle the user can select starting from `start`.
 *
 * The selection can grow up to `MAX_EDIT_SELECTION_PX` in any direction from
 * the start point, clamped to the full image boundary. Near edges the strip
 * will simply be narrower than `EDIT_STRIP_PX` — no extra margin is enforced.
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
// Drawing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw a single rectangle on `ctx`. The rect is in image-pixel coordinates;
 * it is projected to canvas-buffer coordinates via `scaleX` / `scaleY`.
 */
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
 * Render the selection overlay onto the canvas.
 *
 * When no drag is active only the faint image-boundary guide is shown.
 * Once the user starts dragging, two rectangles appear:
 *   1. currentStrip  — the selection outset by EDIT_STRIP_PX (clips at image edge)
 *   2. currentSelect — the user's active selection
 *
 * The selection is clamped to a dynamic max box of MAX_EDIT_SELECTION_PX from
 * the start point, bounded by the image edges.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  drag: DragState | null,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  const bufW = canvas.width
  const bufH = canvas.height
  ctx.clearRect(0, 0, bufW, bufH)

  const scaleX = bufW / imgW
  const scaleY = bufH / imgH

  // ── Image boundary — faint guide, always visible ──────────────────────────
  const maxStripRect: ImageRect = { x: 0, y: 0, w: imgW, h: imgH }
  drawRect(ctx, maxStripRect, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,0.4)',
    lineWidth: 1.5,
    dash: [6, 4],
  })

  if (!drag) {
    return
  }

  // ── Dynamic max reachable from start, clamped to image bounds ─────────────
  const dynamicMax = computeDynamicMaxRect(drag.start, maxStripRect)

  // ── Compute normalised selection clamped to the dynamic guide ─────────────
  const rawSelect = normaliseRect(drag.start, drag.current)
  const currentSelect = clampRect(rawSelect, dynamicMax)

  if (currentSelect.w < 2 || currentSelect.h < 2) {
    return
  }

  // ── Rectangle 3: currentStrip — theme-context border around selection ─────
  const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, maxStripRect)
  drawRect(ctx, currentStrip, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(60,140,255,0.18)',
    lineWidth: 6,
    dash: [],
  })

  // ── Rectangle 4: currentSelect — the active selection ────────────────────
  drawRect(ctx, currentSelect, scaleX, scaleY, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(30,100,220,0.22)',
    lineWidth: 6,
    dash: [],
  })
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
    if (file) {
      onDropFile(file)
    }
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
  /** Data URL of the source image loaded in Extender. Null when none. */
  image: string | null
  /** Natural pixel dimensions of `image`. */
  dimensions: { width: number; height: number } | null
  onPickFile: () => void
  onDropFile: (file: File) => void
}

/**
 * Edit mode workspace. Renders the source image with a transparent canvas
 * overlay that lets the user draw a rectangular selection. As the user drags,
 * four concentric rectangles are rendered live:
 *
 *   1. maxStripRect   — full image boundary (outermost guide)
 *   2. maxSelectRect  — maximum allowable selection (image − EDIT_STRIP_PX on each side)
 *   3. currentStrip   — theme-context ring around the current selection
 *   4. currentSelect  — the user's active selection (innermost)
 */
export function EditStudio({ image, dimensions, onPickFile, onDropFile }: EditStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const isDraggingRef = useRef(false)

  const [drag, setDrag] = useState<DragState | null>(null)

  // ── Sync canvas buffer size to natural image dimensions ───────────────────
  // The canvas element is stretched via CSS to match the displayed <img>, but
  // its internal pixel buffer must match the natural dimensions so EDIT_STRIP_PX
  // refers to actual image pixels.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) {
      return
    }
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  // ── Redraw overlay whenever drag state changes ────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) {
      return
    }
    renderOverlay(canvas, dimensions.width, dimensions.height, drag)
  }, [drag, dimensions])

  // ── Mouse event handlers ──────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dimensions) {
        return
      }
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      e.preventDefault()
      isDraggingRef.current = true
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag({ start: pt, current: pt, committed: false })
    },
    [dimensions],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) {
        return
      }
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag((prev) => (prev ? { ...prev, current: pt } : null))
    },
    [dimensions],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) {
        return
      }
      isDraggingRef.current = false
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag((prev) => {
        if (!prev) {
          return null
        }
        const raw = normaliseRect(prev.start, pt)
        // Discard tiny accidental clicks (< 8px in either axis)
        if (raw.w < 8 || raw.h < 8) {
          return null
        }
        return { ...prev, current: pt, committed: true }
      })
    },
    [dimensions],
  )

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) {
      // Cancel an in-progress drag when the pointer leaves the canvas
      isDraggingRef.current = false
      setDrag((prev) => {
        if (!prev) {
          return null
        }
        const raw = normaliseRect(prev.start, prev.current)
        if (raw.w < 8 || raw.h < 8) {
          return null
        }
        return { ...prev, committed: true }
      })
    }
  }, [])

  // ── Empty state ───────────────────────────────────────────────────────────

  if (!image || !dimensions) {
    return <EmptyEditState onPickFile={onPickFile} onDropFile={onDropFile} />
  }

  // ── Canvas cursor: crosshair while over the selectable area ──────────────

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 pb-6 pt-2">
      {/* Image frame */}
      <div className="relative anim-fade">
        <div
          className="relative overflow-hidden checker rounded-[var(--radius-lg)]"
          style={{
            border: '1px solid var(--border)',
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
          }}
        >
          {/* Source image — never moves */}
          <img
            ref={imgRef}
            src={image}
            alt=""
            className="block max-h-[calc(100vh-260px)] max-w-[min(1200px,calc(100vw-96px))] object-contain anim-fade"
            draggable={false}
          />

          {/* Overlay canvas — same CSS size as the <img>, buffer = image pixels */}
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
              cursor: 'crosshair',
              touchAction: 'none',
            }}
          />
        </div>
      </div>

      {/* Below-image meta row — fixed height so the image never shifts */}
      <div className="mt-5 flex h-8 items-center gap-3 anim-slide-up">
        {dimensions && (
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
        )}
        {/* Status / action slot — always occupies the same height */}
        <div className="flex h-full items-center">
          {!drag && (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Click and drag to select a region
            </span>
          )}
          {drag && !drag.committed && (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Release to confirm selection
            </span>
          )}
          {drag && drag.committed && (
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
  )
}
