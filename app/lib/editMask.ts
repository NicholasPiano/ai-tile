/** A point in image-pixel (or context-local) space. */
export type EditPathPoint = { x: number; y: number }

/** Axis-aligned rect in the same space as {@link EditPathPoint}. */
export type EditPathRect = { x: number; y: number; w: number; h: number }

/** Which marquee the user is drawing with. */
export type EditSelectTool = 'rect' | 'lasso' | 'seam'

/**
 * True when the tool draws a freehand lasso. Rectangle and Seam share a box.
 */
export function isLassoTool(tool: EditSelectTool): boolean {
  return tool === 'lasso'
}

/** Skip lasso samples closer than this (image pixels) to the previous point. */
export const LASSO_SAMPLE_MIN_PX = 3

/** Minimum freehand stroke length (image px) to keep a lasso. */
export const MIN_LASSO_LENGTH_PX = 24

/**
 * True when `path` is a closed freeform polygon (rectangle mode uses `[]`).
 */
export function isFreeformPath(path: readonly EditPathPoint[]): boolean {
  return path.length >= 3
}

/**
 * Axis-aligned bounds of `points`, or null when empty.
 */
export function pathBounds(points: readonly EditPathPoint[]): EditPathRect | null {
  if (points.length === 0) {
    return null
  }
  let minX = points[0].x
  let minY = points[0].y
  let maxX = points[0].x
  let maxY = points[0].y
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (p.x < minX) {
      minX = p.x
    }
    if (p.y < minY) {
      minY = p.y
    }
    if (p.x > maxX) {
      maxX = p.x
    }
    if (p.y > maxY) {
      maxY = p.y
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Polyline length through `points` (open — does not add the closing chord).
 */
export function pathLength(points: readonly EditPathPoint[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    sum += Math.hypot(dx, dy)
  }
  return sum
}

/**
 * Append `next` when it is at least `minDist` from the last point.
 */
export function appendLassoPoint(
  points: readonly EditPathPoint[],
  next: EditPathPoint,
  minDist: number = LASSO_SAMPLE_MIN_PX,
): EditPathPoint[] {
  const last = points[points.length - 1]
  if (!last) {
    return [{ x: next.x, y: next.y }]
  }
  if (Math.hypot(next.x - last.x, next.y - last.y) < minDist) {
    return [...points]
  }
  return [...points, { x: next.x, y: next.y }]
}

/**
 * Translate every point by `(dx, dy)` — image space → context-local, etc.
 */
export function translatePath(
  points: readonly EditPathPoint[],
  dx: number,
  dy: number,
): EditPathPoint[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

/**
 * Scale every point by `(sx, sy)` about the origin.
 */
export function scalePath(
  points: readonly EditPathPoint[],
  sx: number,
  sy: number,
): EditPathPoint[] {
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }))
}

/**
 * Trace a closed polygon. No-op when there are fewer than 2 points.
 * Caller must `beginPath` before this and `fill` / `stroke` / `clip` after.
 */
export function traceClosedPath(
  ctx: CanvasRenderingContext2D,
  points: readonly EditPathPoint[],
): void {
  if (points.length < 2) {
    return
  }
  const first = points[0]
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y)
  }
  ctx.closePath()
}

/**
 * Fill `path` and stroke it with `lineWidth = 2 * radius`, round joins —
 * a canvas approximation of Euclidean dilation by `radius`.
 */
export function fillDilatedPath(
  ctx: CanvasRenderingContext2D,
  points: readonly EditPathPoint[],
  radius: number,
): void {
  if (!isFreeformPath(points) || radius < 0) {
    return
  }
  ctx.beginPath()
  traceClosedPath(ctx, points)
  ctx.fill()
  if (radius > 0) {
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = radius * 2
    ctx.stroke()
  }
}

/**
 * Rasterize the closed selection (no dilation) into an opaque-on-transparent mask.
 */
export function rasterizeSelectionMask(
  points: readonly EditPathPoint[],
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (!isFreeformPath(points)) {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  traceClosedPath(ctx, points)
  ctx.fill()
  return canvas
}

/**
 * Rasterize the dilated selection (fill + round stroke) as an opaque mask.
 */
export function rasterizeDilatedMask(
  points: readonly EditPathPoint[],
  width: number,
  height: number,
  radius: number,
): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (!isFreeformPath(points)) {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#ffffff'
  fillDilatedPath(ctx, points, radius)
  return canvas
}

/**
 * True when `mask` has any non-zero alpha inside `tile` (context-local).
 */
export function tileHasMaskPixels(
  mask: HTMLCanvasElement,
  tile: { x: number; y: number; w: number; h: number },
): boolean {
  const ctx = mask.getContext('2d')
  if (!ctx) {
    return false
  }
  const x = Math.max(0, Math.floor(tile.x))
  const y = Math.max(0, Math.floor(tile.y))
  const x2 = Math.min(mask.width, Math.ceil(tile.x + tile.w))
  const y2 = Math.min(mask.height, Math.ceil(tile.y + tile.h))
  const w = x2 - x
  const h = y2 - y
  if (w < 1 || h < 1) {
    return false
  }
  const data = ctx.getImageData(x, y, w, h).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      return true
    }
  }
  return false
}

/**
 * Stamp `source` onto `dest` using `mask` as destination-in (same size).
 * Returns false when a 2d context is missing.
 */
export function applyMaskToCanvas(
  dest: HTMLCanvasElement,
  source: CanvasImageSource,
  mask: HTMLCanvasElement,
): boolean {
  if (dest.width !== mask.width || dest.height !== mask.height) {
    return false
  }
  const ctx = dest.getContext('2d')
  if (!ctx) {
    return false
  }
  ctx.clearRect(0, 0, dest.width, dest.height)
  ctx.drawImage(source, 0, 0, dest.width, dest.height)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(mask, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  return true
}
