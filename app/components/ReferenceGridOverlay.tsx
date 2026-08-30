'use client'

import { GRID_CELL_PX, gridCellLabel, gridLayout } from '@/app/lib/referenceGrid'

/**
 * CSS overlay that paints the same 1000×1000 reference grid as
 * `drawReferenceGrid`, using percentages so it scales with the displayed
 * image box. Does not intercept pointer events.
 */
export function ReferenceGridOverlay({
  width,
  height,
}: {
  /** Image-pixel width of the framed surface (source, or source + band). */
  width: number
  /** Image-pixel height of the framed surface. */
  height: number
}) {
  const layout = gridLayout(width, height)
  if (layout.cells.length === 0) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      aria-hidden
    >
      {Array.from({ length: layout.cols - 1 }, (_unused, idx) => {
        const col = idx + 1
        const leftPct = (col * GRID_CELL_PX / width) * 100
        return (
          <div
            key={`v-${col}`}
            className="absolute top-0 bottom-0"
            style={{
              left: `${leftPct}%`,
              width: 0,
              borderLeft: '1.5px solid rgba(232, 196, 120, 0.72)',
            }}
          />
        )
      })}
      {Array.from({ length: layout.rows - 1 }, (_unused, idx) => {
        const row = idx + 1
        const topPct = (row * GRID_CELL_PX / height) * 100
        return (
          <div
            key={`h-${row}`}
            className="absolute left-0 right-0"
            style={{
              top: `${topPct}%`,
              height: 0,
              borderTop: '1.5px solid rgba(232, 196, 120, 0.72)',
            }}
          />
        )
      })}
      {layout.cells.map((cell) => {
        const leftPct = (cell.x / width) * 100
        const topPct = (cell.y / height) * 100
        return (
          <span
            key={`l-${cell.col}-${cell.row}`}
            className="absolute font-semibold tabular-nums leading-none"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              margin: '0.35%',
              fontSize: 'clamp(10px, 1.1vw, 14px)',
              color: 'rgba(255, 236, 190, 0.95)',
              textShadow: '0 0 4px rgba(12, 10, 6, 0.9), 0 1px 2px rgba(12, 10, 6, 0.85)',
            }}
          >
            {gridCellLabel(cell.col, cell.row)}
          </span>
        )
      })}
    </div>
  )
}
