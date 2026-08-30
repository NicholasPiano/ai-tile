/**
 * Fixed-size map reference grid shared by the on-screen overlay and Save bake.
 * Cells are GRID_CELL_PX on each axis; the last row/column may be smaller.
 */

export const GRID_CELL_PX = 1000

/** One cell in image-pixel space. Column and row are 1-indexed. */
export interface GridCell {
  col: number
  row: number
  x: number
  y: number
  w: number
  h: number
}

/** Full grid geometry for an image of `width` × `height` pixels. */
export interface GridLayout {
  width: number
  height: number
  cols: number
  rows: number
  cells: GridCell[]
}

/**
 * Build the cell list for an image. Returns an empty layout when either
 * dimension is not a positive finite number.
 */
export function gridLayout(width: number, height: number): GridLayout {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0, cols: 0, rows: 0, cells: [] }
  }

  const cols = Math.ceil(width / GRID_CELL_PX)
  const rows = Math.ceil(height / GRID_CELL_PX)
  const cells: GridCell[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * GRID_CELL_PX
      const y = row * GRID_CELL_PX
      const w = Math.min(GRID_CELL_PX, width - x)
      const h = Math.min(GRID_CELL_PX, height - y)
      if (w <= 0 || h <= 0) {
        continue
      }
      cells.push({
        col: col + 1,
        row: row + 1,
        x,
        y,
        w,
        h,
      })
    }
  }

  return { width, height, cols, rows, cells }
}

/**
 * Label painted in the top-left of a cell (`col,row`).
 */
export function gridCellLabel(col: number, row: number): string {
  return `${col},${row}`
}

/**
 * Stroke the grid and paint cell labels onto an existing canvas. Does not
 * change canvas size. Safe no-op when width/height are invalid or ctx is
 * already in a bad state.
 */
export function drawReferenceGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const layout = gridLayout(width, height)
  if (layout.cells.length === 0) {
    return
  }

  const minDim = Math.min(width, height)
  const lineWidth = Math.max(2, Math.round(minDim / 1000))
  const fontPx = Math.max(14, Math.round(Math.min(GRID_CELL_PX, minDim) * 0.036))
  const pad = Math.max(6, Math.round(fontPx * 0.35))

  ctx.save()
  ctx.lineWidth = lineWidth
  ctx.strokeStyle = 'rgba(232, 196, 120, 0.72)'
  ctx.beginPath()
  for (let col = 1; col < layout.cols; col++) {
    const x = col * GRID_CELL_PX + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  for (let row = 1; row < layout.rows; row++) {
    const y = row * GRID_CELL_PX + 0.5
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
  }
  ctx.stroke()

  ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  for (const cell of layout.cells) {
    const label = gridCellLabel(cell.col, cell.row)
    const tx = cell.x + pad
    const ty = cell.y + pad
    ctx.lineWidth = Math.max(3, Math.round(fontPx / 5))
    ctx.strokeStyle = 'rgba(12, 10, 6, 0.78)'
    ctx.strokeText(label, tx, ty)
    ctx.fillStyle = 'rgba(255, 236, 190, 0.95)'
    ctx.fillText(label, tx, ty)
  }
  ctx.restore()
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
      reject(new Error('Failed to load image for grid overlay'))
    }
    img.src = src
  })
}

/**
 * Composite the reference grid onto a copy of `imageDataUrl` and return a
 * PNG data URL. The result has the same pixel dimensions as the source.
 */
export async function bakeReferenceGrid(imageDataUrl: string): Promise<string> {
  const img = await loadImageElement(imageDataUrl)
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (width <= 0 || height <= 0) {
    throw new Error('Cannot overlay grid on an empty image')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to get canvas context for grid overlay')
  }

  ctx.drawImage(img, 0, 0)
  drawReferenceGrid(ctx, width, height)
  return canvas.toDataURL('image/png')
}
