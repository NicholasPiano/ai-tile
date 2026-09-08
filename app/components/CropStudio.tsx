'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icons } from '@/app/components/icons'
import { ReferenceGridOverlay } from '@/app/components/ReferenceGridOverlay'
import {
  ASPECT_PRESETS,
  applyAspectFromCorner,
  applyAspectToCrop,
  aspectRatioForPreset,
  clampCropRect,
  customAspectInput,
  cropImageToRect,
  isFullImageCrop,
  parseAspectRatio,
  parseCustomAspectPair,
  simplifiedAspectParts,
  snapCropToGrid,
  type AspectPreset,
  type CropRect,
} from '@/app/lib/crop'
import { bakeReferenceGrid } from '@/app/lib/referenceGrid'
import { timestampForFilename } from '@/app/lib/app'

const SIDEBAR_W = 360
const VIEW_MIN_ZOOM = 0.1
const VIEW_MAX_ZOOM = 8
const VIEW_ZOOM_FACTOR = 1.12
const VIEW_PINCH_ZOOM_SENSITIVITY = 0.01
const HANDLE_PX = 10

type ImagePoint = { x: number; y: number }
type ViewTransform = { zoom: number; panX: number; panY: number }
type ViewportSize = { w: number; h: number }
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'

type DragKind =
  | { kind: 'draw'; origin: ImagePoint; previous: CropRect }
  | { kind: 'handle'; handle: Handle; start: CropRect; origin: ImagePoint }

/** Ignore click-without-drag so a miss does not collapse the crop. */
const MIN_DRAW_PX = 8

/** Clamp `n` to `[lo, hi]`. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Clamp zoom to the allowed range. */
function clampZoom(zoom: number): number {
  return clamp(zoom, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM)
}

/**
 * Uniform scale that fits the whole image inside the viewport.
 */
function fitZoomForViewport(viewport: ViewportSize, imgW: number, imgH: number): number {
  if (viewport.w <= 0 || viewport.h <= 0 || imgW <= 0 || imgH <= 0) {
    return 1
  }
  return clampZoom(Math.min(viewport.w / imgW, viewport.h / imgH))
}

/**
 * Keep the image on screen: centered when smaller than the frame,
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

/** Center the image at `zoom` (full-resolution when zoom is 1). */
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

/** Map a pointer position into image-pixel space. */
function viewportToImage(
  clientX: number,
  clientY: number,
  viewportEl: HTMLElement,
  view: ViewTransform,
): ImagePoint {
  const rect = viewportEl.getBoundingClientRect()
  return {
    x: (clientX - rect.left - view.panX) / view.zoom,
    y: (clientY - rect.top - view.panY) / view.zoom,
  }
}

/** Axis-aligned rect from two opposite corners. */
function normaliseCorners(a: ImagePoint, b: ImagePoint): CropRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/**
 * Resize `start` by the pointer delta for the given handle, then lock
 * aspect and clamp.
 */
function resizeFromHandle(
  start: CropRect,
  handle: Handle,
  dx: number,
  dy: number,
  ratio: number | null,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (handle === 'move') {
    return clampCropRect(
      { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h },
      imageWidth,
      imageHeight,
    )
  }

  let x = start.x
  let y = start.y
  let w = start.w
  let h = start.h
  const moveW = handle.includes('e') || handle.includes('w')
  const moveH = handle.includes('n') || handle.includes('s')

  if (handle.includes('e')) {
    w = start.w + dx
  }
  if (handle.includes('w')) {
    x = start.x + dx
    w = start.w - dx
  }
  if (handle.includes('s')) {
    h = start.h + dy
  }
  if (handle.includes('n')) {
    y = start.y + dy
    h = start.h - dy
  }

  if (w < 1) {
    x = handle.includes('w') ? start.x + start.w - 1 : start.x
    w = 1
  }
  if (h < 1) {
    y = handle.includes('n') ? start.y + start.h - 1 : start.y
    h = 1
  }

  if (ratio && ratio > 0) {
    if (moveW && !moveH) {
      h = w / ratio
      y = start.y + start.h / 2 - h / 2
    } else if (moveH && !moveW) {
      w = h * ratio
      x = start.x + start.w / 2 - w / 2
    } else {
      const fromW = Math.abs(w / ratio - h) <= Math.abs(h * ratio - w)
      if (fromW) {
        h = w / ratio
        if (handle.includes('n')) {
          y = start.y + start.h - h
        }
      } else {
        w = h * ratio
        if (handle.includes('w')) {
          x = start.x + start.w - w
        }
      }
    }
  }

  return clampCropRect({ x, y, w, h }, imageWidth, imageHeight)
}

/**
 * Which resize handle (or the move interior) is under `pt`, or null when
 * the pointer is outside the crop chrome.
 */
function hitHandle(pt: ImagePoint, crop: CropRect, zoom: number): Handle | null {
  const pad = HANDLE_PX / Math.max(zoom, 0.01)
  const x2 = crop.x + crop.w
  const y2 = crop.y + crop.h
  const near = (a: number, b: number) => Math.abs(a - b) <= pad
  const insideX = pt.x >= crop.x - pad && pt.x <= x2 + pad
  const insideY = pt.y >= crop.y - pad && pt.y <= y2 + pad
  if (!insideX || !insideY) {
    return null
  }
  const onN = near(pt.y, crop.y)
  const onS = near(pt.y, y2)
  const onW = near(pt.x, crop.x)
  const onE = near(pt.x, x2)
  if (onN && onW) {
    return 'nw'
  }
  if (onN && onE) {
    return 'ne'
  }
  if (onS && onW) {
    return 'sw'
  }
  if (onS && onE) {
    return 'se'
  }
  if (onN) {
    return 'n'
  }
  if (onS) {
    return 's'
  }
  if (onW) {
    return 'w'
  }
  if (onE) {
    return 'e'
  }
  if (pt.x >= crop.x && pt.x <= x2 && pt.y >= crop.y && pt.y <= y2) {
    return 'move'
  }
  return null
}

/** CSS cursor for the current hover/drag handle. */
function cursorForHandle(handle: Handle | null, panning: boolean): string {
  if (panning) {
    return 'grabbing'
  }
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'move':
      return 'move'
    default:
      return 'crosshair'
  }
}

/**
 * Convert a wheel delta into CSS pixels. Trackpad pans arrive as
 * `DOM_DELTA_PIXEL`; mouse wheels are often line-based.
 */
function wheelDeltaPx(delta: number, deltaMode: number, viewportH: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * 16
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * viewportH
  }
  return delta
}

export interface CropStudioProps {
  image: string | null
  dimensions: { width: number; height: number } | null
  onPickFile: () => void
  onDropFile: (file: File) => void
  showGrid: boolean
  /**
   * Commit the crop as the new working image. Caller updates dimensions.
   */
  onApply: (imageUrl: string, dimensions: { width: number; height: number }) => void
}

/**
 * Crop workspace — trim the working image with a resizable rectangle.
 *
 * Apply writes the crop back into the project (same as accepting an edit).
 * Save downloads the cropped pixels; with Grid on, the baked overlay is
 * cropped so cell labels match what is on screen.
 */
export function CropStudio({
  image,
  dimensions,
  onPickFile,
  onDropFile,
  showGrid,
  onApply,
}: CropStudioProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const customAspectWRef = useRef<HTMLInputElement>(null)
  const viewportSizeRef = useRef<ViewportSize>({ w: 0, h: 0 })
  const viewReadyRef = useRef(false)
  const spaceDownRef = useRef(false)
  const isPanningRef = useRef(false)
  const panLastRef = useRef<{ x: number; y: number } | null>(null)
  /**
   * Crop frozen when Custom (or any aspect lock) starts / after a drag.
   * Custom field keystrokes reshape from this base so typing 1→10→1000
   * does not compound on a destroyed selection.
   */
  const aspectBaseCropRef = useRef<CropRect | null>(null)

  const [view, setView] = useState<ViewTransform>({ zoom: 1, panX: 0, panY: 0 })
  const [spaceDown, setSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [aspect, setAspect] = useState<AspectPreset>('free')
  const [customAspectW, setCustomAspectW] = useState('')
  const [customAspectH, setCustomAspectH] = useState('')
  const [snapGrid, setSnapGrid] = useState(false)
  const [drag, setDrag] = useState<DragKind | null>(null)
  const [hoverHandle, setHoverHandle] = useState<Handle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  spaceDownRef.current = spaceDown

  useEffect(() => {
    if (aspect !== 'custom') {
      return
    }
    customAspectWRef.current?.focus()
    customAspectWRef.current?.select()
  }, [aspect])

  useEffect(() => {
    setSnapGrid(showGrid)
  }, [showGrid])

  useEffect(() => {
    if (!dimensions) {
      setCrop(null)
      aspectBaseCropRef.current = null
      return
    }
    const full = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    setCrop(full)
    aspectBaseCropRef.current = full
    setAspect('free')
    setError(null)
  }, [dimensions?.width, dimensions?.height, image])

  useEffect(() => {
    viewReadyRef.current = false
  }, [dimensions?.width, dimensions?.height])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !dimensions) {
      return
    }
    const applySize = (next: ViewportSize) => {
      viewportSizeRef.current = next
      if (next.w <= 0 || next.h <= 0) {
        return
      }
      if (!viewReadyRef.current) {
        viewReadyRef.current = true
        setView(centeredView(1, next, dimensions.width, dimensions.height))
        return
      }
      setView((prev) =>
        clampViewTransform(prev, next, dimensions.width, dimensions.height),
      )
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      applySize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(viewport)
    applySize({ w: viewport.clientWidth, h: viewport.clientHeight })
    return () => {
      ro.disconnect()
    }
  }, [dimensions])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !dimensions) {
      return
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = viewport.getBoundingClientRect()
        const dy = wheelDeltaPx(e.deltaY, e.deltaMode, viewportSizeRef.current.h)
        const factor = Math.exp(-dy * VIEW_PINCH_ZOOM_SENSITIVITY)
        setView((prev) =>
          zoomViewAt(
            prev,
            prev.zoom * factor,
            e.clientX - rect.left,
            e.clientY - rect.top,
            viewportSizeRef.current,
            dimensions.width,
            dimensions.height,
          ),
        )
        return
      }
      const dx = wheelDeltaPx(e.deltaX, e.deltaMode, viewportSizeRef.current.h)
      const dy = wheelDeltaPx(e.deltaY, e.deltaMode, viewportSizeRef.current.h)
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
    return () => {
      viewport.removeEventListener('wheel', onWheel)
    }
  }, [dimensions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      setIsPanning(false)
      isPanningRef.current = false
      panLastRef.current = null
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  /**
   * Final clamp (and optional grid snap). Aspect is applied by the live
   * draw/resize paths so this does not re-center the rect.
   */
  const finishRect = useCallback(
    (rect: CropRect): CropRect => {
      if (!dimensions) {
        return rect
      }
      let next = clampCropRect(rect, dimensions.width, dimensions.height)
      if (snapGrid) {
        next = snapCropToGrid(next, dimensions.width, dimensions.height)
      }
      return next
    },
    [dimensions, snapGrid],
  )

  const customAspect = customAspectInput(customAspectW, customAspectH)

  /**
   * Snapshot the rect that later custom-field edits reshape from.
   */
  const captureAspectBase = (rect: CropRect | null) => {
    aspectBaseCropRef.current = rect
      ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
      : null
  }

  /**
   * Fit `base` (or the frozen aspect base) to `ratio`, then write the crop.
   */
  const applyRatioToBase = (ratio: number | null, base?: CropRect | null) => {
    const source = base ?? aspectBaseCropRef.current
    if (!source || !dimensions || !ratio) {
      return
    }
    let fitted = applyAspectToCrop(source, ratio, dimensions.width, dimensions.height)
    if (snapGrid) {
      fitted = snapCropToGrid(fitted, dimensions.width, dimensions.height)
      fitted = applyAspectToCrop(fitted, ratio, dimensions.width, dimensions.height)
    }
    setCrop(fitted)
  }

  const setAspectPreset = (next: AspectPreset) => {
    let nextCustom = customAspect
    if (next === 'custom' && parseAspectRatio(nextCustom) === null && crop) {
      const parts = simplifiedAspectParts(crop.w, crop.h)
      setCustomAspectW(parts.w)
      setCustomAspectH(parts.h)
      nextCustom = customAspectInput(parts.w, parts.h)
    }
    if (crop) {
      captureAspectBase(crop)
    }
    setAspect(next)
    if (!dimensions) {
      return
    }
    applyRatioToBase(
      aspectRatioForPreset(next, dimensions.width, dimensions.height, nextCustom),
      aspectBaseCropRef.current,
    )
  }

  /**
   * Update the custom fields. Live-reshape only when BOTH width and height
   * are valid — always from the frozen base crop, never the live crop.
   */
  const updateCustomAspect = (nextW: string, nextH: string) => {
    setCustomAspectW(nextW)
    setCustomAspectH(nextH)
    if (aspect !== 'custom' || !dimensions) {
      return
    }
    const pair = parseCustomAspectPair(nextW, nextH)
    if (pair === null) {
      return
    }
    applyRatioToBase(pair)
  }

  /**
   * Commit custom fields on blur: pair if both filled, else a lone decimal
   * (e.g. `1.85`) from the frozen base.
   */
  const commitCustomAspectFields = () => {
    if (aspect !== 'custom' || !dimensions) {
      return
    }
    const pair = parseCustomAspectPair(customAspectW, customAspectH)
    if (pair !== null) {
      applyRatioToBase(pair)
      return
    }
    const lone = parseAspectRatio(customAspectInput(customAspectW, customAspectH))
    if (lone !== null) {
      applyRatioToBase(lone)
    }
  }

  const resetCrop = () => {
    if (!dimensions) {
      return
    }
    const full = { x: 0, y: 0, w: dimensions.width, h: dimensions.height }
    setAspect('free')
    setCrop(full)
    captureAspectBase(full)
    setError(null)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current || !dimensions || !crop || busy) {
      return
    }
    if (e.button !== 0) {
      return
    }
    if (spaceDownRef.current) {
      isPanningRef.current = true
      setIsPanning(true)
      panLastRef.current = { x: e.clientX, y: e.clientY }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    const pt = viewportToImage(e.clientX, e.clientY, viewportRef.current, view)
    const handle = hitHandle(pt, crop, view.zoom)
    if (handle) {
      setDrag({ kind: 'handle', handle, start: crop, origin: pt })
    } else {
      setDrag({ kind: 'draw', origin: pt, previous: crop })
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!viewportRef.current || !dimensions || !crop) {
      return
    }
    if (isPanningRef.current && panLastRef.current) {
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
      return
    }
    const pt = viewportToImage(e.clientX, e.clientY, viewportRef.current, view)
    if (!drag) {
      setHoverHandle(spaceDown ? null : hitHandle(pt, crop, view.zoom))
      return
    }
    const ratio = aspectRatioForPreset(aspect, dimensions.width, dimensions.height, customAspect)
    if (drag.kind === 'draw') {
      const drawn = ratio
        ? applyAspectFromCorner(drag.origin, pt, ratio, dimensions.width, dimensions.height)
        : normaliseCorners(drag.origin, pt)
      setCrop(finishRect(drawn))
      return
    }
    const next = resizeFromHandle(
      drag.start,
      drag.handle,
      pt.x - drag.origin.x,
      pt.y - drag.origin.y,
      ratio,
      dimensions.width,
      dimensions.height,
    )
    setCrop(snapGrid ? snapCropToGrid(next, dimensions.width, dimensions.height) : next)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanningRef.current) {
      isPanningRef.current = false
      setIsPanning(false)
      panLastRef.current = null
    }
    if (drag && crop) {
      if (drag.kind === 'draw' && (crop.w < MIN_DRAW_PX || crop.h < MIN_DRAW_PX)) {
        setCrop(drag.previous)
        captureAspectBase(drag.previous)
      } else {
        const finished = finishRect(crop)
        setCrop(finished)
        captureAspectBase(finished)
      }
    }
    setDrag(null)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Capture may already be released.
    }
  }

  const nudgeZoom = (dir: 1 | -1) => {
    if (!dimensions) {
      return
    }
    const vp = viewportSizeRef.current
    setView((prev) => {
      const originX = vp.w / 2
      const originY = vp.h / 2
      return zoomViewAt(
        prev,
        prev.zoom * (dir > 0 ? VIEW_ZOOM_FACTOR : 1 / VIEW_ZOOM_FACTOR),
        originX,
        originY,
        vp,
        dimensions.width,
        dimensions.height,
      )
    })
  }

  const setZoomPreset = (preset: 'fit' | 'full') => {
    if (!dimensions) {
      return
    }
    const vp = viewportSizeRef.current
    const zoom = preset === 'fit' ? fitZoomForViewport(vp, dimensions.width, dimensions.height) : 1
    setView(centeredView(zoom, vp, dimensions.width, dimensions.height))
  }

  /**
   * Rasterize the current crop. When `withGrid` is true, bake the reference
   * grid onto the full source first so cell labels match the overlay.
   */
  const rasterizeCrop = async (withGrid: boolean): Promise<{ url: string; rect: CropRect }> => {
    if (!image || !dimensions || !crop) {
      throw new Error('Nothing to crop')
    }
    const rect = finishRect(crop)
    if (rect.w < 1 || rect.h < 1) {
      throw new Error('Crop is empty')
    }
    const source = withGrid ? await bakeReferenceGrid(image) : image
    const url = await cropImageToRect(source, rect)
    return { url, rect }
  }

  const handleApply = async () => {
    if (!crop || !dimensions || busy) {
      return
    }
    if (isFullImageCrop(crop, dimensions.width, dimensions.height)) {
      setError('Crop is the full image — drag the handles to trim first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { url, rect } = await rasterizeCrop(false)
      onApply(url, { width: rect.w, height: rect.h })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply crop')
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async () => {
    if (!image || !crop || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { url } = await rasterizeCrop(showGrid)
      const link = document.createElement('a')
      link.href = url
      link.download = `cropped_${timestampForFilename()}.png`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save crop')
    } finally {
      setBusy(false)
    }
  }

  if (!image || !dimensions) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-6">
        <div
          className="max-w-md rounded-[var(--radius-lg)] border px-8 py-10 text-center"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)' }}
        >
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Load an image in <strong>Extender</strong> first, then switch to Crop to trim it.
          </p>
          <button onClick={onPickFile} className="btn btn-ghost mt-4 text-[12px]">
            Upload image
          </button>
        </div>
      </div>
    )
  }

  const contentW = dimensions.width * view.zoom
  const contentH = dimensions.height * view.zoom
  const zoomPct = Math.round(view.zoom * 100)
  const ratio = aspectRatioForPreset(aspect, dimensions.width, dimensions.height, customAspect)
  const canApply = crop !== null && !isFullImageCrop(crop, dimensions.width, dimensions.height)
  const hover = drag
    ? drag.kind === 'handle'
      ? drag.handle
      : null
    : hoverHandle
  const frameCursor = spaceDown || isPanning
    ? isPanning
      ? 'grabbing'
      : 'grab'
    : cursorForHandle(hover, false)

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (file && file.type.startsWith('image/')) {
          onDropFile(file)
        }
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden pt-2">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden px-6">
          <div
            ref={viewportRef}
            className="relative h-full min-h-0 min-w-0 overflow-hidden checker rounded-[var(--radius-lg)]"
            style={{
              border: '1px solid var(--border)',
              boxShadow:
                '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
              cursor: frameCursor,
              touchAction: 'none',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
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
                src={image}
                alt=""
                width={dimensions.width}
                height={dimensions.height}
                className="block"
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
              {crop ? (
                <CropChrome crop={crop} imageWidth={dimensions.width} imageHeight={dimensions.height} />
              ) : null}
            </div>
          </div>
        </div>

        <aside
          className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          style={{
            width: SIDEBAR_W,
            minWidth: SIDEBAR_W,
            maxWidth: SIDEBAR_W,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Crop
            </span>
            <button
              className="btn btn-ghost text-[12px]"
              style={{ padding: '2px 10px', height: 28 }}
              onClick={() => { void handleSave() }}
              disabled={busy || !crop}
              title={showGrid ? 'Download cropped PNG with reference grid' : 'Download cropped PNG'}
            >
              <Icons.Download size={12} />
              Save
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Drag the rectangle or its handles. Apply writes the trim back into
              Extender and Edit. Save downloads the crop without changing the
              working image.
            </p>

            <div>
              <p
                className="mb-1.5 text-[11px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Size
              </p>
              <p className="font-mono text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                {crop ? `${crop.w} × ${crop.h}` : '—'}
                <span className="ml-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {crop ? `at ${crop.x}, ${crop.y}` : ''}
                </span>
              </p>
              <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {`Source ${dimensions.width} × ${dimensions.height}`}
              </p>
            </div>

            <div>
              <p
                className="mb-1.5 text-[11px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Aspect
              </p>
              <div className="flex flex-wrap gap-1">
                {ASPECT_PRESETS.map((preset) => {
                  const active = aspect === preset.value
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      className="btn btn-ghost text-[11px]"
                      style={{
                        padding: '2px 8px',
                        height: 26,
                        color: active ? 'var(--accent)' : undefined,
                        borderColor: active ? 'var(--accent-border)' : undefined,
                      }}
                      onClick={() => setAspectPreset(preset.value)}
                    >
                      {preset.label}
                    </button>
                  )
                })}
              </div>
              {aspect === 'custom' ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <input
                    ref={customAspectWRef}
                    type="text"
                    inputMode="decimal"
                    aria-label="Custom aspect width"
                    placeholder="21"
                    value={customAspectW}
                    onChange={(e) => updateCustomAspect(e.target.value, customAspectH)}
                    onBlur={commitCustomAspectFields}
                    className="w-16 rounded-[var(--radius-sm)] px-2 py-1 font-mono text-[12px]"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                  />
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    :
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Custom aspect height"
                    placeholder="9"
                    value={customAspectH}
                    onChange={(e) => updateCustomAspect(customAspectW, e.target.value)}
                    onBlur={commitCustomAspectFields}
                    className="w-16 rounded-[var(--radius-sm)] px-2 py-1 font-mono text-[12px]"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                  />
                </div>
              ) : null}
              {ratio ? (
                <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {aspect === 'original'
                    ? 'Locked to the source ratio.'
                    : aspect === 'custom'
                      ? `Locked to ${customAspectH.trim() ? `${customAspectW.trim()}:${customAspectH.trim()}` : customAspectW.trim()}.`
                      : `Locked to ${aspect}.`}
                </p>
              ) : aspect === 'custom' ? (
                <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Enter both width and height (e.g. 21:9). A single decimal applies on blur.
                </p>
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={snapGrid}
                onChange={(e) => {
                  const on = e.target.checked
                  setSnapGrid(on)
                  if (on && crop && dimensions) {
                    setCrop(finishRect(crop))
                  }
                }}
              />
              Snap to 1000×1000 grid
            </label>

            {error ? (
              <div
                className="rounded-lg border px-3 py-2 text-[12px]"
                style={{
                  borderColor: 'var(--danger)',
                  background: 'rgba(200,40,40,0.08)',
                  color: 'var(--danger)',
                }}
              >
                {error}
              </div>
            ) : null}

            <button
              className="btn btn-primary w-full"
              onClick={() => { void handleApply() }}
              disabled={busy || !canApply}
            >
              Apply crop
            </button>
            <button
              className="btn btn-ghost w-full"
              onClick={resetCrop}
              disabled={busy}
            >
              Reset to full image
            </button>
          </div>
        </aside>
      </div>

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
          >
            <Icons.Minus size={12} />
          </button>
          <button
            className="btn btn-ghost font-mono text-[11px]"
            style={{ padding: '2px 8px', height: 28, minWidth: 52 }}
            onClick={() => setZoomPreset('full')}
          >
            {`${zoomPct}%`}
          </button>
          <button
            className="btn btn-ghost text-[12px]"
            style={{ padding: '2px 8px', height: 28 }}
            onClick={() => nudgeZoom(1)}
          >
            <Icons.Plus size={12} />
          </button>
          <button
            className="btn btn-ghost text-[12px]"
            style={{ padding: '2px 8px', height: 28 }}
            onClick={() => setZoomPreset('fit')}
          >
            Fit
          </button>
        </div>
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          Drag handles to resize · Space-drag to pan
        </span>
      </div>
    </div>
  )
}

/**
 * Dimmed mask, crop border, and eight resize handles in image-pixel space
 * (the parent is already scaled by zoom).
 */
function CropChrome({
  crop,
  imageWidth,
  imageHeight,
}: {
  crop: CropRect
  imageWidth: number
  imageHeight: number
}) {
  const xPct = (crop.x / imageWidth) * 100
  const yPct = (crop.y / imageHeight) * 100
  const wPct = (crop.w / imageWidth) * 100
  const hPct = (crop.h / imageHeight) * 100
  const handles: { id: Handle; left: string; top: string }[] = [
    { id: 'nw', left: `${xPct}%`, top: `${yPct}%` },
    { id: 'n', left: `${xPct + wPct / 2}%`, top: `${yPct}%` },
    { id: 'ne', left: `${xPct + wPct}%`, top: `${yPct}%` },
    { id: 'e', left: `${xPct + wPct}%`, top: `${yPct + hPct / 2}%` },
    { id: 'se', left: `${xPct + wPct}%`, top: `${yPct + hPct}%` },
    { id: 's', left: `${xPct + wPct / 2}%`, top: `${yPct + hPct}%` },
    { id: 'sw', left: `${xPct}%`, top: `${yPct + hPct}%` },
    { id: 'w', left: `${xPct}%`, top: `${yPct + hPct / 2}%` },
  ]

  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute"
        style={{
          left: 0,
          top: 0,
          width: `${xPct}%`,
          height: '100%',
          background: 'rgba(8, 8, 12, 0.45)',
        }}
      />
      <div
        className="absolute"
        style={{
          left: `${xPct + wPct}%`,
          top: 0,
          right: 0,
          height: '100%',
          background: 'rgba(8, 8, 12, 0.45)',
        }}
      />
      <div
        className="absolute"
        style={{
          left: `${xPct}%`,
          top: 0,
          width: `${wPct}%`,
          height: `${yPct}%`,
          background: 'rgba(8, 8, 12, 0.45)',
        }}
      />
      <div
        className="absolute"
        style={{
          left: `${xPct}%`,
          top: `${yPct + hPct}%`,
          width: `${wPct}%`,
          bottom: 0,
          background: 'rgba(8, 8, 12, 0.45)',
        }}
      />
      <div
        className="absolute"
        style={{
          left: `${xPct}%`,
          top: `${yPct}%`,
          width: `${wPct}%`,
          height: `${hPct}%`,
          boxShadow: '0 0 0 1.5px rgba(232, 196, 120, 0.95)',
        }}
      />
      {handles.map((handle) => (
        <div
          key={handle.id}
          className="absolute"
          style={{
            left: handle.left,
            top: handle.top,
            width: 10,
            height: 10,
            marginLeft: -5,
            marginTop: -5,
            borderRadius: 2,
            background: 'rgba(255, 236, 190, 0.95)',
            boxShadow: '0 0 0 1px rgba(12, 10, 6, 0.7)',
          }}
        />
      ))}
    </div>
  )
}
