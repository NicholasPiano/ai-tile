'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EDIT_STRIP_PX,
  INPAINT_VARIANT_COUNT,
  MAX_AI_DIMENSION,
  TILE_REFINE_VARIANT_COUNT,
  createEmptyInpaintTileSlots,
  createEmptyInpaintVariants,
  selectedInpaintVariant,
  selectedTileResultUrl,
  tileSlotHasResult,
  timestampForFilename,
  type InpaintState,
  type InpaintRegion,
  type InpaintTilePlan,
  type InpaintTileSlot,
  type InpaintVariant,
  type ReferenceImage,
} from '@/app/lib/app'
import { EditPanel } from '@/app/components/EditPanel'
import { EditToolPicker } from '@/app/components/EditToolPicker'
import { Icons } from '@/app/components/icons'
import { ReferenceGridOverlay } from '@/app/components/ReferenceGridOverlay'
import { bakeReferenceGrid } from '@/app/lib/referenceGrid'
import {
  appendLassoPoint,
  isFreeformPath,
  MIN_LASSO_LENGTH_PX,
  pathBounds,
  pathLength,
  scalePath,
  translatePath,
  type EditSelectTool,
} from '@/app/lib/editMask'
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
  stampPlanIntoContextCanvas,
  stampPlanIntoSource,
} from '@/app/utils/imageProcessor'

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

/** A point in image-pixel space. */
type ImagePoint = { x: number; y: number }

/** An axis-aligned rectangle in image-pixel space. */
type ImageRect = { x: number; y: number; w: number; h: number }

/**
 * Active drag. Rectangle uses opposite corners; lasso uses sampled points.
 * `committed` is true once the user releases the mouse button.
 */
type DragState =
  | { kind: 'rect'; start: ImagePoint; current: ImagePoint; committed: boolean }
  | { kind: 'lasso'; points: ImagePoint[]; committed: boolean }

/** Ignore click-without-drag so a miss does not keep a 1×1 selection. */
const MIN_DRAW_PX = 8

/** CSS-pixel slop for click-to-deselect on the letterbox around the image. */
const DESELECT_CLICK_PX = 8

/**
 * True once the session has left the pre-generate input phase. A generated
 * (or in-flight) plan must not be discarded by a stray click.
 */
function editSessionLocked(inpaintState: InpaintState | null): boolean {
  return inpaintState !== null && inpaintState.phase !== 'input'
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
 * Convert a pointer event's client coordinates into image-pixel coordinates,
 * accounting for object-contain letterboxing inside the overlay canvas.
 */
function toImageCoord(
  e: React.PointerEvent<HTMLCanvasElement>,
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
 * Snap a rect to integer image pixels so the plan canvas, tile grid, and
 * Accept stamp all share the same coordinates.
 */
function snapImageRect(r: ImageRect): ImageRect {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const x2 = Math.round(r.x + r.w)
  const y2 = Math.round(r.y + r.h)
  return {
    x,
    y,
    w: Math.max(1, x2 - x),
    h: Math.max(1, y2 - y),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewport zoom / pan (CSS pixels; zoom 1 = one image pixel per CSS pixel)
// ─────────────────────────────────────────────────────────────────────────────

/** Floor so a 4k image can still be seen in full inside the frame. */
const VIEW_MIN_ZOOM = 0.1
/** Ceiling for pixel inspection past native resolution. */
const VIEW_MAX_ZOOM = 8
/** Multiplier applied once per toolbar + / − click. */
const VIEW_ZOOM_FACTOR = 1.12
/**
 * Pinch / ctrl-wheel scale per CSS-pixel of deltaY. Trackpads fire many
 * small events; a discrete 1.12× step per event was far too jumpy.
 */
const VIEW_PINCH_ZOOM_SENSITIVITY = 0.01

/** Pan/zoom of the image inside the clipped edit viewport. */
type ViewTransform = {
  zoom: number
  panX: number
  panY: number
}

/** CSS-pixel size of the clipped image frame. */
type ViewportSize = {
  w: number
  h: number
}

/**
 * Clamp zoom to the allowed range.
 */
function clampZoom(zoom: number): number {
  return clamp(zoom, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM)
}

/**
 * Uniform scale that fits the whole image inside the viewport.
 */
function fitZoomForViewport(
  viewport: ViewportSize,
  imgW: number,
  imgH: number,
): number {
  if (viewport.w <= 0 || viewport.h <= 0 || imgW <= 0 || imgH <= 0) {
    return 1
  }
  return clampZoom(Math.min(viewport.w / imgW, viewport.h / imgH))
}

/**
 * Keep the image on screen: centered when it is smaller than the frame,
 * otherwise clamped so the frame stays filled with image pixels.
 */
function clampViewTransform(
  view: ViewTransform,
  viewport: ViewportSize,
  imgW: number,
  imgH: number,
): ViewTransform {
  const zoom = clampZoom(view.zoom)
  const contentW = imgW * zoom
  const contentH = imgH * zoom
  let panX = view.panX
  let panY = view.panY
  if (viewport.w <= 0 || viewport.h <= 0) {
    return { zoom, panX, panY }
  }
  if (contentW <= viewport.w) {
    panX = (viewport.w - contentW) / 2
  } else {
    panX = clamp(view.panX, viewport.w - contentW, 0)
  }
  if (contentH <= viewport.h) {
    panY = (viewport.h - contentH) / 2
  } else {
    panY = clamp(view.panY, viewport.h - contentH, 0)
  }
  return { zoom, panX, panY }
}

/**
 * Center the image at `zoom` (full-resolution when zoom is 1).
 */
function centeredView(
  zoom: number,
  viewport: ViewportSize,
  imgW: number,
  imgH: number,
): ViewTransform {
  return clampViewTransform(
    { zoom: clampZoom(zoom), panX: 0, panY: 0 },
    viewport,
    imgW,
    imgH,
  )
}

/**
 * Change zoom while keeping the image point under `origin` (viewport CSS
 * coordinates) fixed — wheel-zoom toward the cursor.
 */
function zoomViewAt(
  view: ViewTransform,
  nextZoom: number,
  originX: number,
  originY: number,
  viewport: ViewportSize,
  imgW: number,
  imgH: number,
): ViewTransform {
  if (view.zoom <= 0) {
    return centeredView(nextZoom, viewport, imgW, imgH)
  }
  const zoom = clampZoom(nextZoom)
  const imgX = (originX - view.panX) / view.zoom
  const imgY = (originY - view.panY) / view.zoom
  return clampViewTransform(
    {
      zoom,
      panX: originX - imgX * zoom,
      panY: originY - imgY * zoom,
    },
    viewport,
    imgW,
    imgH,
  )
}

/** Normalise and clamp an in-progress or committed drag to the image bounds. */
function selectionFromDrag(drag: DragState, imageBounds: ImageRect): ImageRect {
  if (drag.kind === 'lasso') {
    const bounds = pathBounds(drag.points)
    if (!bounds) {
      return { x: 0, y: 0, w: 0, h: 0 }
    }
    return clampRect(bounds, imageBounds)
  }
  return clampRect(normaliseRect(drag.start, drag.current), imageBounds)
}

/** Closed lasso points, or `[]` for a rectangle marquee. */
function pathFromDrag(drag: DragState): ImagePoint[] {
  if (drag.kind === 'lasso') {
    return drag.points
  }
  return []
}

/**
 * True when the gesture is large enough to keep (not a click-to-deselect).
 */
function selectionIsKeepable(drag: DragState, imageBounds: ImageRect): boolean {
  const sel = selectionFromDrag(drag, imageBounds)
  if (sel.w < MIN_DRAW_PX || sel.h < MIN_DRAW_PX) {
    return false
  }
  if (drag.kind === 'lasso') {
    if (drag.points.length < 3) {
      return false
    }
    if (pathLength(drag.points) < MIN_LASSO_LENGTH_PX) {
      return false
    }
  }
  return true
}

/** Snap rectangle corners to the clamped selection so overlay and preview stay aligned. */
function committedRectFromSelection(sel: ImageRect): DragState {
  return {
    kind: 'rect',
    start: { x: sel.x, y: sel.y },
    current: { x: sel.x + sel.w, y: sel.y + sel.h },
    committed: true,
  }
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
  const cssToBuf = layout.containerH > 0 ? bufH / layout.containerH : 1
  const dash = options.dash?.map((n) => n * cssToBuf)
  drawBufferRect(ctx, buf, {
    ...options,
    dash,
    lineWidth: (options.lineWidth ?? 1.5) * cssToBuf,
  })
}

/**
 * Draw a white label just outside the top-left corner of a rectangle.
 * `fontCssPx` is a screen-pixel size so labels stay readable on both
 * small and large displayed images (the overlay buffer is natural-res).
 */
function drawImageLabel(
  ctx: CanvasRenderingContext2D,
  r: ImageRect,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
  text: string,
  fontCssPx: number = 12,
): void {
  const buf = imageRectToBuffer(r, layout, bufW, bufH)
  const cssToBuf = layout.containerH > 0 ? bufH / layout.containerH : 1
  const scaledFont = fontCssPx * cssToBuf
  const pad = 4 * cssToBuf
  const cx = buf.x + pad
  const aboveY = buf.y - pad
  const cy = aboveY >= scaledFont ? aboveY : buf.y + scaledFont + pad
  ctx.save()
  ctx.font = `600 ${scaledFont}px ui-sans-serif, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.shadowColor = 'rgba(0,0,0,0.85)'
  ctx.shadowBlur = 4 * cssToBuf
  ctx.fillText(text, cx, cy)
  ctx.restore()
}

/**
 * Map an image-space polyline into overlay-buffer coordinates.
 */
function pathToBuffer(
  points: ImagePoint[],
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
): ImagePoint[] {
  return points.map((p) => imageToBufferCoord(p.x, p.y, layout, bufW, bufH))
}

/**
 * Image-pixel length expressed in overlay-buffer pixels (x-axis).
 */
function imagePxToBuffer(
  px: number,
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
): number {
  const origin = imageToBufferCoord(0, 0, layout, bufW, bufH)
  const along = imageToBufferCoord(px, 0, layout, bufW, bufH)
  return Math.abs(along.x - origin.x)
}

/**
 * Stroke (and optionally fill/close) a polyline in image space.
 */
function drawImagePath(
  ctx: CanvasRenderingContext2D,
  points: ImagePoint[],
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
  options: {
    strokeStyle: string
    fillStyle?: string
    lineWidth?: number
    dash?: number[]
    close?: boolean
  },
): void {
  if (points.length < 2) {
    return
  }
  const buf = pathToBuffer(points, layout, bufW, bufH)
  const first = buf[0]
  if (!first) {
    return
  }
  const cssToBuf = layout.containerH > 0 ? bufH / layout.containerH : 1
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < buf.length; i++) {
    ctx.lineTo(buf[i].x, buf[i].y)
  }
  if (options.close) {
    ctx.closePath()
  }
  if (options.fillStyle) {
    ctx.fillStyle = options.fillStyle
    ctx.fill()
  }
  ctx.strokeStyle = options.strokeStyle
  ctx.lineWidth = (options.lineWidth ?? 1.5) * cssToBuf
  ctx.setLineDash((options.dash ?? []).map((n) => n * cssToBuf))
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.restore()
}

/**
 * Fill the lasso and its constant-width context ring, then outline both.
 */
function drawLassoOverlay(
  ctx: CanvasRenderingContext2D,
  points: ImagePoint[],
  layout: ObjectContainLayout,
  bufW: number,
  bufH: number,
  committed: boolean,
): void {
  if (points.length < 2) {
    return
  }
  const cssToBuf = layout.containerH > 0 ? bufH / layout.containerH : 1
  const bufRadius = imagePxToBuffer(EDIT_STRIP_PX, layout, bufW, bufH)
  const buf = pathToBuffer(points, layout, bufW, bufH)
  const first = buf[0]
  const last = buf[buf.length - 1]
  if (!first || !last) {
    return
  }

  if (!committed) {
    drawImagePath(ctx, points, layout, bufW, bufH, {
      strokeStyle: 'rgba(255,255,255,0.95)',
      lineWidth: 2,
    })
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(first.x, first.y)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2 * cssToBuf
    ctx.setLineDash([6 * cssToBuf, 4 * cssToBuf])
    ctx.stroke()
    ctx.restore()
    return
  }

  const traceBuf = (target: CanvasRenderingContext2D) => {
    target.beginPath()
    target.moveTo(first.x, first.y)
    for (let i = 1; i < buf.length; i++) {
      target.lineTo(buf[i].x, buf[i].y)
    }
    target.closePath()
  }

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Context ring — same wash as the rectangle outset (over the photo, not white).
  ctx.fillStyle = 'rgba(60,140,255,0.18)'
  ctx.strokeStyle = 'rgba(60,140,255,0.18)'
  ctx.lineWidth = bufRadius * 2
  traceBuf(ctx)
  ctx.fill()
  ctx.stroke()

  // Selection interior — same wash as the rectangle marquee.
  ctx.fillStyle = 'rgba(30,100,220,0.22)'
  traceBuf(ctx)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,1)'
  ctx.lineWidth = 6 * cssToBuf
  ctx.stroke()
  ctx.restore()

  // Thin white halo around the dilated context, punched so it does not
  // sit under the blue tints.
  const halo = document.createElement('canvas')
  halo.width = bufW
  halo.height = bufH
  const haloCtx = halo.getContext('2d')
  if (!haloCtx) {
    return
  }
  haloCtx.lineJoin = 'round'
  haloCtx.lineCap = 'round'
  haloCtx.fillStyle = '#ffffff'
  haloCtx.strokeStyle = '#ffffff'
  traceBuf(haloCtx)
  haloCtx.fill()
  haloCtx.lineWidth = bufRadius * 2 + 6 * cssToBuf
  haloCtx.stroke()
  haloCtx.globalCompositeOperation = 'destination-out'
  traceBuf(haloCtx)
  haloCtx.fill()
  haloCtx.lineWidth = bufRadius * 2
  haloCtx.stroke()
  ctx.drawImage(halo, 0, 0)
}

/**
 * True once at least one plan URL exists, or the session has left the
 * input / in-flight planning phases. Used to hide the selection box so
 * the merge seam is visible.
 */
function inpaintPlanExists(inpaintState: InpaintState | null): boolean {
  if (!inpaintState) {
    return false
  }
  if (inpaintState.phase === 'tiling' || inpaintState.phase === 'done') {
    return true
  }
  return inpaintState.variants.some((variant) => variant.globalPlanUrl !== null)
}

/**
 * Render the selection overlay onto the main image. After a plan exists
 * the overlay stays empty so the merge (plan or tiles) is shown unmarked.
 */
function renderOverlay(
  canvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  drag: DragState | null,
  inpaintState: InpaintState | null,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  const bufW = canvas.width
  const bufH = canvas.height
  ctx.clearRect(0, 0, bufW, bufH)

  // Merge is the unmarked photo. No boxes, tile grid, or plan wash.
  if (inpaintPlanExists(inpaintState)) {
    return
  }

  const cssRect = canvas.getBoundingClientRect()
  const layout = computeObjectContainLayout(cssRect.width, cssRect.height, imgW, imgH)

  // Faint image-boundary guide — visible while choosing a region.
  const imageBounds: ImageRect = { x: 0, y: 0, w: imgW, h: imgH }
  drawImageRect(ctx, imageBounds, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,0.4)',
    lineWidth: 1.5,
    dash: [6, 4],
  })

  if (!drag) {
    return
  }

  // Live redraw replaces the committed shape; otherwise prefer the region.
  const livePath = pathFromDrag(drag)
  const currentPath =
    !drag.committed
      ? livePath
      : (inpaintState?.region.selectionPath ?? livePath)
  const currentSelect =
    !drag.committed
      ? selectionFromDrag(drag, imageBounds)
      : (inpaintState?.region.selectionRect ?? selectionFromDrag(drag, imageBounds))

  if (isFreeformPath(currentPath) || (drag.kind === 'lasso' && !drag.committed)) {
    drawLassoOverlay(ctx, currentPath, layout, bufW, bufH, drag.committed)
    if (drag.committed && currentSelect.w >= 2 && currentSelect.h >= 2) {
      const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, imageBounds)
      drawImageLabel(ctx, currentStrip, layout, bufW, bufH, 'Context')
      drawImageLabel(ctx, currentSelect, layout, bufW, bufH, 'Selection')
    }
    return
  }

  if (currentSelect.w < 2 || currentSelect.h < 2) {
    return
  }

  const currentStrip = outsetRect(currentSelect, EDIT_STRIP_PX, imageBounds)
  drawImageRect(ctx, currentStrip, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(60,140,255,0.18)',
    lineWidth: 6,
  })
  drawImageLabel(ctx, currentStrip, layout, bufW, bufH, 'Context')

  drawImageRect(ctx, currentSelect, layout, bufW, bufH, {
    strokeStyle: 'rgba(255,255,255,1)',
    fillStyle: 'rgba(30,100,220,0.22)',
    lineWidth: 6,
  })
  drawImageLabel(ctx, currentSelect, layout, bufW, bufH, 'Selection')
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
  /** Paint the 1000×1000 reference grid over the photo. */
  showGrid?: boolean
}

/**
 * Edit mode workspace.
 *
 * Renders the source image with a transparent canvas overlay for interactive
 * selection drawing. Once the user commits a selection the sidebar transitions
 * to the input form. On submit:
 *
 *   1. Generate → buildGlobalPlanInput once, then INPAINT_VARIANT_COUNT
 *        parallel /api/edit 'plan' calls (same settings) → variants[]
 *   2.          → computeChangeMask per variant (client-side pixel diff)
 *   3.          → buildGlobalInpaintComposite per variant: hard plan inside
 *                 the selection (no extra blur), crisp source in the ring.
 *                 Display / Accept use stampPlanIntoContextCanvas.
 *   Fast path (context ≤ MAX_AI_DIMENSION): the hard plan stamp IS the
 *     final result — no refine pass needed, jump straight to phase 'done'.
 *   Full path (context > MAX_AI_DIMENSION):
 *   3a.         → planInpaintTiles (phase → 'tiling', idle)
 *   4. Per tile (manual): cropInpaintTileInput (plain crop from the hard
 *        plan guide + earlier tiles) → /api/edit 'refine' → compositeInpaintTileResult
 *        (aligned overwrite of maskSubRect onto the hard plan stamp)
 *   5. Accept → stitchedPreviewUrl (same overwrite the user is looking at)
 *
 * Re-run controls exist for the plan (cascades to mask/tiles), the mask
 * (reuses the plan), and each tile individually (full path only).
 */
const SIDEBAR_W = 360

/** Response shape for any /api/edit phase that returns a generated image URL. */
type EditPhaseResponse = { resultUrl?: string; error?: string }

/**
 * Stage 1 — global plan. Sends a prebuilt plan canvas to the LLM 'plan'
 * phase and returns the plan URL plus the context→plan-pixel scale factor.
 */
async function requestGlobalPlan(args: {
  dataUrl: string
  scale: number
  editPrompt: string
  referenceImages: ReferenceImage[]
  apiKey: string
  model: string
}): Promise<{ globalPlanUrl: string; globalPlanScale: number }> {
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 'plan',
      imageDataUrl: args.dataUrl,
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
  return { globalPlanUrl: data.resultUrl, globalPlanScale: args.scale }
}

/**
 * Finish one variant after its plan URL is known: change mask, preview
 * visuals, the full-resolution composite canvas, and a merge snapshot so
 * plan cycling can show the result before any tiles run.
 */
async function buildVariantFromPlan(args: {
  image: string
  contextRect: { x: number; y: number; w: number; h: number }
  selectionRect: { x: number; y: number; w: number; h: number }
  selectionPath: { x: number; y: number }[]
  lowResContextUrl: string | null
  globalPlanUrl: string
  globalPlanScale: number
  tileCount: number
}): Promise<{
  variant: InpaintVariant
  /** Hard plan in the selection — tile-refine guide. */
  canvas: HTMLCanvasElement
  /** Hard plan overwrite — display / Accept / tile-merge base. */
  hardCanvas: HTMLCanvasElement
  changeMaskCanvas: HTMLCanvasElement | null
}> {
  let changeMaskCanvas: HTMLCanvasElement | null = null
  if (args.lowResContextUrl) {
    changeMaskCanvas = await computeChangeMask(args.lowResContextUrl, args.globalPlanUrl, 10)
  }

  let changeMaskUrl: string | null = null
  let changeMaskOverlayUrl: string | null = null
  if (changeMaskCanvas) {
    const visuals = await buildChangeMaskVisuals(changeMaskCanvas, args.globalPlanUrl)
    changeMaskUrl = visuals.maskUrl
    changeMaskOverlayUrl = visuals.overlayUrl
  }

  const canvas = await buildGlobalInpaintComposite(
    args.image,
    args.contextRect,
    args.globalPlanUrl,
    args.selectionRect,
    args.selectionPath,
  )

  // Display / Accept merge: the plan crop pasted into the source. The
  // `canvas` is the tile-refine guide (same plan, no extra blur).
  const hardCanvas = await stampPlanIntoContextCanvas(
    args.image,
    args.contextRect,
    args.globalPlanUrl,
    args.selectionPath,
  )
  const stitchedPreviewUrl = await stampPlanIntoSource(
    args.image,
    args.contextRect,
    args.globalPlanUrl,
    args.selectionPath,
  )

  return {
    variant: {
      globalPlanScale: args.globalPlanScale,
      globalPlanUrl: args.globalPlanUrl,
      changeMaskUrl,
      changeMaskOverlayUrl,
      tileResults: createEmptyInpaintTileSlots(args.tileCount),
      stitchedPreviewUrl,
    },
    canvas,
    hardCanvas,
    changeMaskCanvas,
  }
}

/**
 * Pixel-for-pixel copy of a canvas. Used to keep a pre-tile plan composite
 * so a tile re-run can rebuild the stitch from a clean base.
 */
function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas')
  copy.width = source.width
  copy.height = source.height
  const ctx = copy.getContext('2d')
  if (ctx) {
    ctx.drawImage(source, 0, 0)
  }
  return copy
}

export function EditStudio({ image, dimensions, onPickFile, onDropFile, apiKey, model, onAccept, showGrid = false }: EditStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const isPanningRef = useRef(false)
  const panLastRef = useRef<{ x: number; y: number } | null>(null)
  const spaceDownRef = useRef(false)
  const pendingDeselectRef = useRef<{ x: number; y: number } | null>(null)
  const viewportSizeRef = useRef<ViewportSize>({ w: 0, h: 0 })
  const viewReadyRef = useRef(false)
  /**
   * Per-variant running Accept canvas: hard plan stamp + selected tiles.
   * Never the softened change-mask composite.
   */
  const inpaintCanvasByVariantRef = useRef<Array<HTMLCanvasElement | null>>(
    Array.from({ length: INPAINT_VARIANT_COUNT }, () => null),
  )
  /**
   * Hard plan-in-selection canvas per variant. Tile refine crops from
   * this guide plus earlier tiles — it is not shown or accepted.
   */
  const inpaintBaseCanvasByVariantRef = useRef<Array<HTMLCanvasElement | null>>(
    Array.from({ length: INPAINT_VARIANT_COUNT }, () => null),
  )
  /**
   * Immutable hard plan overwrite per variant. Tile generate rebuilds
   * the Accept canvas from this plus each tile's refine URL.
   */
  const inpaintHardCanvasByVariantRef = useRef<Array<HTMLCanvasElement | null>>(
    Array.from({ length: INPAINT_VARIANT_COUNT }, () => null),
  )
  /** Per-variant client-computed pixel-diff change masks. */
  const changeMaskCanvasByVariantRef = useRef<Array<HTMLCanvasElement | null>>(
    Array.from({ length: INPAINT_VARIANT_COUNT }, () => null),
  )

  const [editTool, setEditTool] = useState<EditSelectTool>('rect')
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const [inpaintState, setInpaintState] = useState<InpaintState | null>(null)
  /**
   * Latest inpaint state for sequential tile generate. `generateTile` must
   * not read `tileResults` from a stale render closure or later tiles
   * overwrite earlier slots.
   */
  const inpaintStateRef = useRef<InpaintState | null>(null)
  inpaintStateRef.current = inpaintState
  /** Bumped when the displayed image size changes so the overlay stays aligned. */
  const [layoutTick, setLayoutTick] = useState(0)
  /**
   * Zoom/pan inside the clipped image frame. `zoom === 1` is full
   * resolution (one image pixel per CSS pixel).
   */
  const [view, setView] = useState<ViewTransform>({ zoom: 1, panX: 0, panY: 0 })
  const [spaceDown, setSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  spaceDownRef.current = spaceDown

  // ── Sync canvas buffer to natural image dimensions ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  // ── Size the clipped viewport; start at 1:1, then keep pan legal ───────────
  // Reset only when the *pixel size* changes (a new photo). Accepting an
  // edit replaces the data URL but keeps the same dimensions — the view
  // must stay put.
  useEffect(() => {
    viewReadyRef.current = false
  }, [dimensions?.width, dimensions?.height])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const applySize = (next: ViewportSize) => {
      viewportSizeRef.current = next
      if (!dimensions || next.w <= 0 || next.h <= 0) {
        return
      }
      if (!viewReadyRef.current) {
        viewReadyRef.current = true
        setView(centeredView(1, next, dimensions.width, dimensions.height))
        return
      }
      setView((prev) => clampViewTransform(prev, next, dimensions.width, dimensions.height))
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      applySize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      })
    })
    ro.observe(viewport)
    applySize({ w: viewport.clientWidth, h: viewport.clientHeight })
    return () => ro.disconnect()
  }, [dimensions])

  // ── Redraw overlay when the displayed image box resizes ────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [dimensions, image])

  // ── Trackpad two-finger drag pans; pinch / ctrl-wheel zooms ────────────────
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !dimensions) {
      return
    }
    /**
     * Convert a wheel delta into CSS pixels. Trackpad two-finger drags
     * arrive as `DOM_DELTA_PIXEL`; mouse wheels are often line-based.
     */
    const wheelDeltaPx = (delta: number, deltaMode: number): number => {
      if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
        return delta * 16
      }
      if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        return delta * viewportSizeRef.current.h
      }
      return delta
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Pinch-to-zoom (Chrome/Safari) and ctrl/cmd + wheel stay zoom.
      if (e.ctrlKey || e.metaKey) {
        const rect = viewport.getBoundingClientRect()
        const originX = e.clientX - rect.left
        const originY = e.clientY - rect.top
        const dy = wheelDeltaPx(e.deltaY, e.deltaMode)
        const factor = Math.exp(-dy * VIEW_PINCH_ZOOM_SENSITIVITY)
        setView((prev) =>
          zoomViewAt(
            prev,
            prev.zoom * factor,
            originX,
            originY,
            viewportSizeRef.current,
            dimensions.width,
            dimensions.height,
          ),
        )
        return
      }
      const dx = wheelDeltaPx(e.deltaX, e.deltaMode)
      const dy = wheelDeltaPx(e.deltaY, e.deltaMode)
      setView((prev) =>
        clampViewTransform(
          { ...prev, panX: prev.panX - dx, panY: prev.panY - dy },
          viewportSizeRef.current,
          dimensions.width,
          dimensions.height,
        ),
      )
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [dimensions])

  // ── Space holds pan (so selection drag stays the default) ──────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) {
        return
      }
      const target = e.target
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return
      }
      e.preventDefault()
      spaceDownRef.current = true
      setSpaceDown(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') {
        return
      }
      spaceDownRef.current = false
      setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ── Redraw overlay on drag or inpaint state changes ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !dimensions) {
      return
    }
    renderOverlay(
      canvas,
      dimensions.width,
      dimensions.height,
      drag,
      inpaintState,
    )
  }, [drag, dimensions, inpaintState, layoutTick])

  // ── Build low-res context crop + annotated preview when selection commits ────
  useEffect(() => {
    if (!drag?.committed || !image || !dimensions) return

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = snapImageRect(selectionFromDrag(drag, imageBounds))
    if (sel.w < 1 || sel.h < 1) return

    const contextRect = snapImageRect(outsetRect(sel, EDIT_STRIP_PX, imageBounds))

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
          const previewPath = scalePath(
            translatePath(pathFromDrag(drag), -contextRect.x, -contextRect.y),
            scaleX,
            scaleY,
          )
          ctx.fillStyle = 'rgba(30,100,220,0.18)'
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'
          ctx.lineWidth = Math.max(1.5, Math.min(scaleX, scaleY) * 2)
          if (isFreeformPath(previewPath)) {
            ctx.beginPath()
            const first = previewPath[0]
            if (first) {
              ctx.moveTo(first.x, first.y)
              for (let i = 1; i < previewPath.length; i++) {
                ctx.lineTo(previewPath[i].x, previewPath[i].y)
              }
              ctx.closePath()
              ctx.fill()
              ctx.stroke()
            }
          } else {
            const lrX = selInCtx.x * scaleX
            const lrY = selInCtx.y * scaleY
            const lrW = selInCtx.w * scaleX
            const lrH = selInCtx.h * scaleY
            ctx.fillRect(lrX, lrY, lrW, lrH)
            ctx.strokeRect(lrX, lrY, lrW, lrH)
          }
        }
        const previewUrl = canvas.toDataURL('image/jpeg', 0.92)
        setInpaintState((prev) =>
          prev ? { ...prev, lowResContextUrl: dataUrl, lowResPreviewUrl: previewUrl } : null,
        )
      }
      img.src = dataUrl
    }).catch(() => {})
  }, [drag, image, dimensions])

  // ── Pointer handlers ───────────────────────────────────────────────────────

  /**
   * Start a selection drag and capture the pointer so leaving the image
   * (viewport chrome, sidebar, window) does not end the gesture.
   * Allowed before generate and while still in the input phase so a
   * click can clear, or a drag can replace, the current area.
   */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dimensions) {
        return
      }
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      if (editSessionLocked(inpaintState)) {
        return
      }
      // Space or middle-mouse is pan — let the viewport handler take it.
      if (spaceDownRef.current || e.button === 1) {
        return
      }
      e.preventDefault()
      isDraggingRef.current = true
      canvas.setPointerCapture(e.pointerId)
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      const nextDrag: DragState =
        editTool === 'lasso'
          ? { kind: 'lasso', points: [pt], committed: false }
          : { kind: 'rect', start: pt, current: pt, committed: false }
      dragRef.current = nextDrag
      setDrag(nextDrag)
    },
    [dimensions, inpaintState, editTool],
  )

  /**
   * Resize the in-progress selection. Capture keeps this firing after the
   * cursor leaves the canvas; image coords stay clamped to the photo.
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) {
        return
      }
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      setDrag((prev) => {
        if (!prev) {
          return null
        }
        if (prev.kind === 'lasso') {
          const next: DragState = {
            kind: 'lasso',
            points: appendLassoPoint(prev.points, pt),
            committed: false,
          }
          dragRef.current = next
          return next
        }
        const next: DragState = { ...prev, current: pt }
        dragRef.current = next
        return next
      })
    },
    [dimensions],
  )

  /**
   * Commit or discard the selection. Called on release and on cancel so a
   * drag cannot stay open after the pointer is gone. A click (movement
   * below {@link MIN_DRAW_PX}) clears a pre-generate selection.
   */
  const finishSelectionDrag = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !dimensions) {
        return
      }
      isDraggingRef.current = false
      const canvas = canvasRef.current
      if (canvas && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId)
      }
      if (!canvas) {
        return
      }
      const pt = toImageCoord(e, canvas, dimensions.width, dimensions.height)
      const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
      const prev = dragRef.current
      if (!prev) {
        return
      }
      const next: DragState =
        prev.kind === 'lasso'
          ? { kind: 'lasso', points: appendLassoPoint(prev.points, pt), committed: false }
          : { ...prev, current: pt }
      if (!selectionIsKeepable(next, imageBounds)) {
        dragRef.current = null
        setDrag(null)
        setInpaintState(null)
        return
      }
      // New shape replaces a pre-generate session so the init effect
      // rebuilds InpaintState for the new region.
      if (inpaintState && inpaintState.phase === 'input') {
        setInpaintState(null)
      }
      const sel = selectionFromDrag(next, imageBounds)
      const committed: DragState =
        next.kind === 'lasso'
          ? { kind: 'lasso', points: next.points, committed: true }
          : committedRectFromSelection(sel)
      dragRef.current = committed
      setDrag(committed)
    },
    [dimensions, inpaintState],
  )

  /**
   * Pan the image inside the frame. Space/middle-mouse while selecting;
   * any drag after a plan has been generated (session is locked).
   */
  const handleViewportPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wantPan =
        spaceDownRef.current || e.button === 1 || editSessionLocked(inpaintState)
      if (wantPan && !isDraggingRef.current) {
        e.preventDefault()
        isPanningRef.current = true
        panLastRef.current = { x: e.clientX, y: e.clientY }
        setIsPanning(true)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      // Letterbox click — canvas already owns image-space gestures.
      if (
        inpaintState !== null &&
        inpaintState.phase === 'input' &&
        e.button === 0 &&
        !isDraggingRef.current
      ) {
        pendingDeselectRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [inpaintState],
  )

  const handleViewportPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanningRef.current || !panLastRef.current || !dimensions) {
        return
      }
      const dx = e.clientX - panLastRef.current.x
      const dy = e.clientY - panLastRef.current.y
      panLastRef.current = { x: e.clientX, y: e.clientY }
      setView((prev) =>
        clampViewTransform(
          { ...prev, panX: prev.panX + dx, panY: prev.panY + dy },
          viewportSizeRef.current,
          dimensions.width,
          dimensions.height,
        ),
      )
    },
    [dimensions],
  )

  const handleViewportPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pending = pendingDeselectRef.current
      pendingDeselectRef.current = null
      if (pending && inpaintState !== null && inpaintState.phase === 'input') {
        const dx = e.clientX - pending.x
        const dy = e.clientY - pending.y
        if (Math.hypot(dx, dy) < DESELECT_CLICK_PX) {
          dragRef.current = null
          setInpaintState(null)
          setDrag(null)
        }
      }
      isPanningRef.current = false
      panLastRef.current = null
      setIsPanning(false)
    },
    [inpaintState],
  )

  /**
   * Step zoom from the viewport center (toolbar + / −).
   */
  const nudgeZoom = useCallback(
    (direction: 1 | -1) => {
      if (!dimensions) {
        return
      }
      const vp = viewportSizeRef.current
      const factor = direction === 1 ? VIEW_ZOOM_FACTOR : 1 / VIEW_ZOOM_FACTOR
      setView((prev) =>
        zoomViewAt(
          prev,
          prev.zoom * factor,
          vp.w / 2,
          vp.h / 2,
          vp,
          dimensions.width,
          dimensions.height,
        ),
      )
    },
    [dimensions],
  )

  const setZoomPreset = useCallback(
    (preset: 'fit' | 'full') => {
      if (!dimensions) {
        return
      }
      const vp = viewportSizeRef.current
      const zoom =
        preset === 'fit'
          ? fitZoomForViewport(vp, dimensions.width, dimensions.height)
          : 1
      setView(centeredView(zoom, vp, dimensions.width, dimensions.height))
    },
    [dimensions],
  )

  // ── Initialise InpaintState when drag commits ──────────────────────────────
  useEffect(() => {
    if (!drag?.committed || !dimensions || inpaintState) return

    const imageBounds: ImageRect = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    const sel = snapImageRect(selectionFromDrag(drag, imageBounds))
    if (sel.w < 1 || sel.h < 1) return

    const contextRect = snapImageRect(outsetRect(sel, EDIT_STRIP_PX, imageBounds))

    const region: InpaintRegion = {
      selectionRect: sel,
      contextRect,
      selectionPath: pathFromDrag(drag),
    }

    setInpaintState({
      phase: 'input',
      region,
      editPrompt: '',
      referenceImages: [],
      lowResContextUrl: null,
      lowResPreviewUrl: null,
      tilePlan: null,
      variants: createEmptyInpaintVariants(),
      selectedVariantIdx: 0,
      planningCompletedCount: 0,
      generatingTileIdx: null,
      error: null,
    })
  }, [drag, dimensions, inpaintState])

  // ── Callback: user submits description — kick off the full pipeline ─────────

  /**
   * Drop every variant's composite and change-mask canvases. Called before
   * Generate / Re-run plan so stale slots cannot be accepted after a failure.
   */
  const clearVariantCanvases = () => {
    inpaintCanvasByVariantRef.current = Array.from({ length: INPAINT_VARIANT_COUNT }, () => null)
    inpaintBaseCanvasByVariantRef.current = Array.from({ length: INPAINT_VARIANT_COUNT }, () => null)
    inpaintHardCanvasByVariantRef.current = Array.from({ length: INPAINT_VARIANT_COUNT }, () => null)
    changeMaskCanvasByVariantRef.current = Array.from({ length: INPAINT_VARIANT_COUNT }, () => null)
  }

  /**
   * Rebuild a plan variant's Accept canvas from its hard plan stamp, then
   * overwrite every tile's refine result in scan order.
   * Returns a full-image stitched preview URL, or null if the stamp is missing.
   */
  const rebuildVariantComposite = async (
    variantIdx: number,
    tileSlots: InpaintTileSlot[],
    tilePlan: InpaintTilePlan,
    sourceImage: string,
    contextRect: { x: number; y: number; w: number; h: number },
  ): Promise<string | null> => {
    const hardBase = inpaintHardCanvasByVariantRef.current[variantIdx]
    if (!hardBase) {
      return null
    }
    const working = cloneCanvas(hardBase)
    for (let i = 0; i < tilePlan.tiles.length; i++) {
      const tile = tilePlan.tiles[i]
      const resultUrl = selectedTileResultUrl(tileSlots[i])
      if (!tile || !tile.maskSubRect || !resultUrl) {
        continue
      }
      await compositeInpaintTileResult(working, sourceImage, resultUrl, tile, contextRect)
    }
    inpaintCanvasByVariantRef.current[variantIdx] = working
    return compositeInpaintFinal(
      sourceImage,
      working,
      contextRect,
      inpaintStateRef.current?.region.selectionPath ?? [],
    )
  }

  /**
   * Run INPAINT_VARIANT_COUNT plan calls with the same prompt and input
   * canvas, then build a change mask + composite per result. Fast path
   * (context ≤ MAX_AI_DIMENSION) jumps to 'done'; otherwise tiles stay
   * idle for the selected variant. No LLM mask-extraction call is made.
   */
  const runPlanAndMask = useCallback(
    async (editPrompt: string, referenceImages: ReferenceImage[], region: InpaintRegion, lowResContextUrl: string | null) => {
      try {
        if (!image) {
          throw new Error('Source image is missing')
        }

        const { contextRect } = region
        const { dataUrl, scale } = await buildGlobalPlanInput(
          image,
          contextRect,
          region.selectionRect,
          region.selectionPath,
        )

        const isFastPath =
          contextRect.w <= MAX_AI_DIMENSION && contextRect.h <= MAX_AI_DIMENSION
        const selInCtx = {
          x: region.selectionRect.x - contextRect.x,
          y: region.selectionRect.y - contextRect.y,
          w: region.selectionRect.w,
          h: region.selectionRect.h,
        }
        const pathInCtx = translatePath(
          region.selectionPath,
          -contextRect.x,
          -contextRect.y,
        )
        const tilePlan = isFastPath
          ? null
          : planInpaintTiles(contextRect.w, contextRect.h, selInCtx, 1536, 384, pathInCtx)
        const tileCount = tilePlan?.tiles.length ?? 0

        const planResults = await Promise.all(
          Array.from({ length: INPAINT_VARIANT_COUNT }, async () => {
            const result = await requestGlobalPlan({
              dataUrl,
              scale,
              editPrompt,
              referenceImages,
              apiKey,
              model,
            })
            setInpaintState((prev) =>
              prev
                ? { ...prev, planningCompletedCount: prev.planningCompletedCount + 1 }
                : null,
            )
            return result
          }),
        )

        const built = await Promise.all(
          planResults.map((plan) =>
            buildVariantFromPlan({
              image,
              contextRect,
              selectionRect: region.selectionRect,
              selectionPath: region.selectionPath,
              lowResContextUrl,
              globalPlanUrl: plan.globalPlanUrl,
              globalPlanScale: plan.globalPlanScale,
              tileCount,
            }),
          ),
        )

        inpaintHardCanvasByVariantRef.current = built.map((item) => item.hardCanvas)
        inpaintCanvasByVariantRef.current = built.map((item) => cloneCanvas(item.hardCanvas))
        inpaintBaseCanvasByVariantRef.current = built.map((item) => item.canvas)
        changeMaskCanvasByVariantRef.current = built.map((item) => item.changeMaskCanvas)

        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                variants: built.map((item) => item.variant),
                selectedVariantIdx: 0,
                planningCompletedCount: INPAINT_VARIANT_COUNT,
                phase: isFastPath ? 'done' : 'tiling',
                tilePlan,
                generatingTileIdx: null,
              }
            : null,
        )
      } catch (e) {
        clearVariantCanvases()
        setInpaintState((prev) =>
          prev
            ? {
                ...prev,
                phase: 'input',
                error: e instanceof Error ? e.message : 'Generation failed',
                generatingTileIdx: null,
                planningCompletedCount: 0,
                variants: createEmptyInpaintVariants(),
                selectedVariantIdx: 0,
                tilePlan: null,
              }
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

      clearVariantCanvases()
      setInpaintState((prev) =>
        prev
          ? {
              ...prev,
              phase: 'planning',
              editPrompt,
              referenceImages,
              error: null,
              variants: createEmptyInpaintVariants(),
              selectedVariantIdx: 0,
              planningCompletedCount: 0,
              tilePlan: null,
              generatingTileIdx: null,
            }
          : null,
      )

      await runPlanAndMask(editPrompt, referenceImages, region, lowResContextUrl)
    },
    [inpaintState, image, runPlanAndMask],
  )

  /**
   * Re-run all four plan options with the current description, same as
   * the first Generate. Existing tiles are cleared because they belonged
   * to the old plans.
   */
  const handleRerunPlan = useCallback(async (editPrompt: string) => {
    if (!inpaintState || !image) {
      return
    }
    const nextEditPrompt = editPrompt.trim() || inpaintState.editPrompt
    await handleGenerate(nextEditPrompt, inpaintState.referenceImages)
  }, [inpaintState, image, handleGenerate])

  // ── Callback: generate / re-run a single tile ──────────────────────────────
  // This is the ONLY path that produces tile pixels — tiles never run
  // automatically. Used by the per-tile buttons and by "Generate all".

  const generateTile = useCallback(
    async (idx: number) => {
      const state = inpaintStateRef.current
      if (!state || !image || !state.tilePlan) {
        return
      }
      const variantIdx = state.selectedVariantIdx
      const selected = state.variants[variantIdx]
      const base = inpaintBaseCanvasByVariantRef.current[variantIdx]
      if (!selected || !selected.globalPlanUrl || !base) {
        return
      }

      const tile = state.tilePlan.tiles[idx]
      if (!tile || !tile.maskSubRect) {
        return
      }

      const { contextRect } = state.region
      const { editPrompt } = state
      const tilePlan = state.tilePlan
      // Latest slots for this variant — not the render-closure copy.
      const latestSlots =
        inpaintStateRef.current?.variants[variantIdx]?.tileResults ?? selected.tileResults

      setInpaintState((prev) => (prev ? { ...prev, generatingTileIdx: idx, error: null } : null))

      try {
        // Crop from a prefix rebuild (base + earlier tiles only) so a re-run
        // of this tile is not conditioned on its own previous version.
        const prefixCanvas = cloneCanvas(base)
        for (let i = 0; i < idx; i++) {
          const earlier = tilePlan.tiles[i]
          const earlierUrl = selectedTileResultUrl(latestSlots[i])
          if (!earlier || !earlier.maskSubRect || !earlierUrl) {
            continue
          }
          await compositeInpaintTileResult(prefixCanvas, image, earlierUrl, earlier, contextRect)
        }
        const tileInputUrl = cropInpaintTileInput(prefixCanvas, tile)

        const requestBody = {
          phase: 'refine' as const,
          imageDataUrl: tileInputUrl,
          editPrompt,
          tileIndex: tile.row * tile.totalCols + tile.col + 1,
          tileCount: tile.totalRows * tile.totalCols,
          apiKey,
          model,
        }

        /**
         * Four parallel free add-detail refine calls so the user can pick.
         */
        const optionResults = await Promise.all(
          Array.from({ length: TILE_REFINE_VARIANT_COUNT }, async () => {
            const tileRes = await fetch('/api/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
            })
            const tileData = await tileRes.json() as { resultUrl?: string; error?: string }
            if (!tileRes.ok || !tileData.resultUrl) {
              throw new Error(tileData.error ?? 'Tile refinement failed')
            }
            return tileData.resultUrl
          }),
        )

        const liveSlots =
          inpaintStateRef.current?.variants[variantIdx]?.tileResults ?? latestSlots
        const nextSlots = [...liveSlots]
        nextSlots[idx] = {
          versions: optionResults,
          selectedIdx: 0,
        }

        const stitchedPreviewUrl = await rebuildVariantComposite(
          variantIdx,
          nextSlots,
          tilePlan,
          image,
          contextRect,
        )

        const latest = inpaintStateRef.current
        if (latest) {
          const variants = [...latest.variants]
          const current = variants[variantIdx]
          if (current) {
            variants[variantIdx] = { ...current, tileResults: nextSlots, stitchedPreviewUrl }
            inpaintStateRef.current = { ...latest, variants, generatingTileIdx: null }
          }
        }

        setInpaintState((prev) => {
          if (!prev) {
            return null
          }
          const variants = [...prev.variants]
          const current = variants[variantIdx]
          if (!current) {
            return { ...prev, generatingTileIdx: null }
          }
          variants[variantIdx] = { ...current, tileResults: nextSlots, stitchedPreviewUrl }
          return { ...prev, variants, generatingTileIdx: null }
        })
      } catch (e) {
        setInpaintState((prev) =>
          prev
            ? { ...prev, generatingTileIdx: null, error: e instanceof Error ? e.message : 'Tile failed' }
            : null,
        )
      }
    },
    [image, apiKey, model],
  )

  /**
   * Cycle one tile's refine version (buttons only). Rebuilds the running
   * Accept canvas from the hard plan stamp + selected versions.
   */
  const handleCycleTileRefine = useCallback(
    (tileIdx: number, delta: 1 | -1) => {
      const state = inpaintStateRef.current
      if (!state || !image || !state.tilePlan || state.generatingTileIdx !== null) {
        return
      }
      const variantIdx = state.selectedVariantIdx
      const selected = state.variants[variantIdx]
      if (!selected) {
        return
      }
      const slot = selected.tileResults[tileIdx]
      if (!slot) {
        return
      }
      const filled = slot.versions
        .map((url, i) => ({ url, i }))
        .filter((entry) => typeof entry.url === 'string' && entry.url.length > 0)
      if (filled.length <= 1) {
        return
      }
      const currentPos = filled.findIndex((entry) => entry.i === slot.selectedIdx)
      const start = currentPos >= 0 ? currentPos : 0
      const nextPos = (start + delta + filled.length) % filled.length
      const nextFilled = filled[nextPos]
      if (!nextFilled) {
        return
      }

      const nextSlots = [...selected.tileResults]
      nextSlots[tileIdx] = { ...slot, selectedIdx: nextFilled.i }

      void (async () => {
        const stitchedPreviewUrl = await rebuildVariantComposite(
          variantIdx,
          nextSlots,
          state.tilePlan as InpaintTilePlan,
          image,
          state.region.contextRect,
        )
        setInpaintState((prev) => {
          if (!prev) {
            return null
          }
          const variants = [...prev.variants]
          const current = variants[variantIdx]
          if (!current) {
            return prev
          }
          variants[variantIdx] = { ...current, tileResults: nextSlots, stitchedPreviewUrl }
          const updated = { ...prev, variants }
          inpaintStateRef.current = updated
          return updated
        })
      })()
    },
    [image],
  )

  // ── Callback: generate every masked tile that hasn't been generated yet ─────

  const handleGenerateAllTiles = useCallback(async () => {
    const plan = inpaintState?.tilePlan
    const selected = inpaintState ? selectedInpaintVariant(inpaintState) : null
    if (!plan || !selected) {
      return
    }
    const pending = plan.tiles
      .map((tile, idx) => ({ tile, idx }))
      .filter(({ tile, idx }) => tile.maskSubRect !== null && !tileSlotHasResult(selected.tileResults[idx]))
      .map(({ idx }) => idx)

    for (const idx of pending) {
      await generateTile(idx)
    }
  }, [inpaintState, generateTile])

  // ── Callback: re-run the whole pipeline (back to input phase) ──────────────

  const handleRerun = useCallback(() => {
    clearVariantCanvases()
    setInpaintState((prev) =>
      prev
        ? {
            ...prev,
            phase: 'input',
            tilePlan: null,
            variants: createEmptyInpaintVariants(),
            selectedVariantIdx: 0,
            planningCompletedCount: 0,
            generatingTileIdx: null,
            error: null,
          }
        : null,
    )
  }, [])

  // ── Callback: accept — stamp inpaint canvas into full image ────────────────

  /**
   * Cycle the visible variant. Disabled while planning or while a tile is
   * in flight so we never refine or accept the wrong canvas.
   */
  const handleCycleVariant = useCallback((delta: 1 | -1) => {
    setInpaintState((prev) => {
      if (!prev || prev.phase === 'planning' || prev.generatingTileIdx !== null) {
        return prev
      }
      const n = prev.variants.length
      if (n <= 1) {
        return prev
      }
      const next = (prev.selectedVariantIdx + delta + n) % n
      return { ...prev, selectedVariantIdx: next }
    })
  }, [])

  const handleAccept = useCallback(async () => {
    const variantIdx = inpaintState?.selectedVariantIdx ?? 0
    const selected = inpaintState ? selectedInpaintVariant(inpaintState) : null
    const inpaintCanvas = inpaintCanvasByVariantRef.current[variantIdx]

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
      // Accept the hard overwrite already on screen. Rebuild after tiles
      // also starts from that stamp, so Accept never writes the softened
      // change-mask blend that is only a tile-refine guide.
      const previewUrl = selected?.stitchedPreviewUrl ?? null
      console.log('[EditStudio] handleAccept: compositing final image…', {
        contextRect: inpaintState.region.contextRect,
        canvasW: inpaintCanvas?.width ?? null,
        canvasH: inpaintCanvas?.height ?? null,
        phase: inpaintState.phase,
        hasPreviewUrl: previewUrl !== null,
      })

      let newImageUrl = previewUrl
      if (!newImageUrl) {
        if (!inpaintCanvas) {
          console.warn('[EditStudio] handleAccept: inpaintCanvas is null')
          setInpaintState((prev) =>
            prev ? { ...prev, error: 'Cannot accept: inpaint canvas is missing. Please try regenerating.' } : null,
          )
          return
        }
        newImageUrl = await compositeInpaintFinal(
          image,
          inpaintCanvas,
          inpaintState.region.contextRect,
          inpaintState.region.selectionPath,
        )
      }

      const isSameAsSource = newImageUrl === image
      console.log('[EditStudio] handleAccept: composite done', {
        urlLength: newImageUrl.length,
        sourceLength: image.length,
        isSameAsSource,
        newPrefix: newImageUrl.slice(0, 40),
        srcPrefix: image.slice(0, 40),
      })

      if (isSameAsSource) {
        setInpaintState((prev) =>
          prev ? { ...prev, error: 'Compositing failed: could not get canvas context. Try reloading the page.' } : null,
        )
        return
      }

      onAccept(newImageUrl)
      setInpaintState(null)
      setDrag(null)
      clearVariantCanvases()
    } catch (e) {
      console.error('[EditStudio] handleAccept error:', e)
      setInpaintState((prev) =>
        prev ? { ...prev, error: e instanceof Error ? e.message : 'Compositing failed' } : null,
      )
    }
  }, [image, inpaintState, onAccept])

  // ── Callback: close panel — clear everything ───────────────────────────────

  const handleClose = useCallback(() => {
    clearVariantCanvases()
    dragRef.current = null
    setInpaintState(null)
    setDrag(null)
  }, [])

  /**
   * Switch Rect / Lasso. Clears a pre-generate selection so the new tool
   * starts from an empty canvas.
   */
  const handleSelectTool = useCallback(
    (next: EditSelectTool) => {
      if (editSessionLocked(inpaintState)) {
        return
      }
      if (next === editTool) {
        return
      }
      setEditTool(next)
      dragRef.current = null
      setDrag(null)
      setInpaintState(null)
    },
    [editTool, inpaintState],
  )

  /**
   * Download the current edit source as PNG. When the reference grid is on,
   * bake it onto a copy — the working image is unchanged.
   */
  const handleSaveImage = useCallback(async () => {
    if (!image) {
      return
    }
    setExportError(null)
    let href = image
    if (showGrid) {
      try {
        href = await bakeReferenceGrid(image)
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'Failed to overlay grid')
        return
      }
    }
    const link = document.createElement('a')
    link.href = href
    link.download = `edited_${timestampForFilename()}.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [image, showGrid])

  // Cycle variants with ← → when the description field is not focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
        return
      }
      const target = e.target
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return
      }
      if (!inpaintState || inpaintState.phase === 'planning' || inpaintState.generatingTileIdx !== null) {
        return
      }
      const hasPlans = inpaintState.variants.some((variant) => variant.globalPlanUrl !== null)
      if (!hasPlans) {
        return
      }
      e.preventDefault()
      handleCycleVariant(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inpaintState, handleCycleVariant])

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!image || !dimensions) {
    return <EmptyEditState onPickFile={onPickFile} onDropFile={onDropFile} />
  }

  const isProcessing =
    inpaintState?.phase === 'planning' ||
    inpaintState?.phase === 'tiling'

  const hasSelection = !!drag?.committed || !!inpaintState
  const selectedMergeUrl = inpaintState
    ? selectedInpaintVariant(inpaintState)?.stitchedPreviewUrl ?? null
    : null
  /** Main image shows the selected merge as soon as a plan exists. */
  const displayImageUrl = selectedMergeUrl ?? image

  const contentW = dimensions.width * view.zoom
  const contentH = dimensions.height * view.zoom
  const zoomPct = Math.round(view.zoom * 100)
  const sessionLocked = editSessionLocked(inpaintState)
  const viewportCursor = isPanning
    ? 'grabbing'
    : spaceDown || sessionLocked
      ? 'grab'
      : 'default'
  const canvasCursor = spaceDown || isPanning
    ? isPanning
      ? 'grabbing'
      : 'grab'
    : sessionLocked || isProcessing
      ? 'default'
      : 'crosshair'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">

      {/*
        Image frame takes leftover width only. The sidebar is a fixed
        column so the photo can never push it off-screen.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden pt-2">

        {/* ── Image frame ─────────────────────────────────────────────────── */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden px-6">
          <div
            ref={viewportRef}
            className="relative h-full min-h-0 min-w-0 overflow-hidden checker rounded-[var(--radius-lg)] anim-fade"
            onPointerDown={handleViewportPointerDown}
            onPointerMove={handleViewportPointerMove}
            onPointerUp={handleViewportPointerUp}
            onPointerCancel={handleViewportPointerUp}
            style={{
              border: '1px solid var(--border)',
              boxShadow:
                '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
              cursor: viewportCursor,
              touchAction: 'none',
              overscrollBehavior: 'none',
            }}
          >
            <div
              className="absolute"
              style={{
                left: view.panX,
                top: view.panY,
                width: contentW,
                height: contentH,
              }}
            >
              <img
                src={displayImageUrl}
                alt=""
                width={dimensions.width}
                height={dimensions.height}
                className="anim-fade block"
                draggable={false}
                style={{
                  width: contentW,
                  height: contentH,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
              />

              {showGrid ? (
                <ReferenceGridOverlay width={dimensions.width} height={dimensions.height} />
              ) : null}

              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishSelectionDrag}
                onPointerCancel={finishSelectionDrag}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: contentW,
                  height: contentH,
                  cursor: canvasCursor,
                  touchAction: 'none',
                  pointerEvents: sessionLocked || isProcessing ? 'none' : 'auto',
                }}
              />
            </div>
          </div>
        </div>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{
          width: SIDEBAR_W,
          minWidth: SIDEBAR_W,
          maxWidth: SIDEBAR_W,
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
                title={exportError ?? (showGrid ? 'Download PNG with reference grid' : 'Download PNG')}
                onClick={() => { void handleSaveImage() }}
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
            editTool={editTool}
            onSelectTool={handleSelectTool}
            onGenerate={(prompt, refs) => { void handleGenerate(prompt, refs) }}
            onRerunPlan={(editPrompt) => { void handleRerunPlan(editPrompt) }}
            onRerunTile={(idx) => { void generateTile(idx) }}
            onGenerateAllTiles={() => { void handleGenerateAllTiles() }}
            onCycleVariant={handleCycleVariant}
            onCycleTileRefine={handleCycleTileRefine}
            onRerun={handleRerun}
            onAccept={() => { void handleAccept() }}
            onClose={handleClose}
          />
        ) : (
          <div className="flex flex-1 flex-col justify-center gap-4 px-4">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Make a selection
            </p>
            <EditToolPicker tool={editTool} onSelect={handleSelectTool} size="large" />
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {editTool === 'lasso'
                ? 'Draw around the area; release closes with a straight line.'
                : 'Click and drag a rectangle on the image.'}
            </p>
            {exportError ? (
              <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
                {exportError}
              </p>
            ) : null}
          </div>
        )}
      </div>
      </div>

      {/* Below-image meta row — outside the shared-height row */}
      <div className="mb-6 mt-4 flex min-h-7 shrink-0 flex-wrap items-center gap-3 px-6">
        <div
          className="rounded-full border px-2.5 py-1 font-mono text-[11px]"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--bg-elev)',
            color: 'var(--text-secondary)',
          }}
        >
          {`${dimensions.width} × ${dimensions.height}`}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="btn btn-ghost text-[12px]"
            style={{ padding: '2px 8px', height: 28 }}
            onClick={() => nudgeZoom(-1)}
            title="Zoom out"
          >
            <Icons.Minus size={12} />
          </button>
          <button
            className="btn btn-ghost font-mono text-[11px]"
            style={{ padding: '2px 8px', height: 28, minWidth: 52 }}
            onClick={() => setZoomPreset('full')}
            title="Display at full resolution (100%)"
          >
            {`${zoomPct}%`}
          </button>
          <button
            className="btn btn-ghost text-[12px]"
            style={{ padding: '2px 8px', height: 28 }}
            onClick={() => nudgeZoom(1)}
            title="Zoom in"
          >
            <Icons.Plus size={12} />
          </button>
          <button
            className="btn btn-ghost text-[12px]"
            style={{ padding: '2px 8px', height: 28 }}
            onClick={() => setZoomPreset('fit')}
            title="Fit the whole image in the frame"
          >
            Fit
          </button>
        </div>
        {drag && !drag.committed && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {drag.kind === 'lasso'
              ? 'Release to close with a straight line'
              : 'Release to confirm selection'}
          </span>
        )}
        {inpaintState?.phase === 'input' && drag?.committed ? (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Click to deselect · Drag to redraw · Space-drag to pan
          </span>
        ) : null}
        {!drag?.committed && !inpaintState && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Two-finger drag to pan · Pinch or +/− to zoom
          </span>
        )}
      </div>

    </div>
  )
}
