'use client'

import { Icons } from '@/app/components/icons'
import { StatusPill } from '@/app/components/TopBar'
import { Direction } from '@/app/lib/app'

// ─────────────────────────────────────────────────────────────────────────────
// Shared tile-display types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal per-cell data the inline band visualisation needs. */
export interface TileCellDisplay {
  row: number
  col: number
  bandX: number
  bandY: number
  tileWidth: number
  tileHeight: number
  /** True = pure-context tile; no API call was made. */
  isSkipped: boolean
  /** -1 when isSkipped, otherwise index into tilePreviews. */
  nonSkippedIndex: number
}

export interface TilingState {
  direction: Direction
  /** Full band dimensions (context strip + extension area). */
  bandWidth: number
  bandHeight: number
  /** Width/height of the context strip that overlaps the source image. */
  contextSize: number
  /** Width/height of the new area being generated. */
  extensionSize: number
  /** Source image pixel dimensions. */
  imageWidth: number
  imageHeight: number
  cells: TileCellDisplay[]
  /** Per non-skipped tile: data URL after API call, or null. */
  tilePreviews: (string | null)[]
  /** Per non-skipped tile: whether the user has accepted the result. */
  tileAccepted: boolean[]
  /** Non-skipped index of the tile currently being generated, or null. */
  generatingTileIdx: number | null
  /** Non-skipped index of the next tile that can be generated/accepted. */
  nextPendingTileIdx: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// TilingBand — inline extension area rendered below/beside the source image
// ─────────────────────────────────────────────────────────────────────────────

/** Extension-only sub-rect of the band canvas in band pixel coordinates. */
interface ExtensionViewport {
  originX: number
  originY: number
  width: number
  height: number
}

function extensionViewport(state: TilingState): ExtensionViewport {
  const { direction, bandWidth, bandHeight, contextSize, extensionSize } = state
  switch (direction) {
    case 'down':
      return { originX: 0, originY: contextSize, width: bandWidth, height: extensionSize }
    case 'up':
      return { originX: 0, originY: 0, width: bandWidth, height: extensionSize }
    case 'right':
      return { originX: contextSize, originY: 0, width: extensionSize, height: bandHeight }
    case 'left':
      return { originX: 0, originY: 0, width: extensionSize, height: bandHeight }
  }
}

/** Map a tile's intersection with the extension viewport to band-UI percentages. */
function tileExtensionLayout(
  cell: TileCellDisplay,
  viewport: ExtensionViewport,
): {
  leftPct: number
  topPct: number
  widthPct: number
  heightPct: number
  imgTopFrac: number
  imgLeftFrac: number
  imgHeightFrac: number
  imgWidthFrac: number
} | null {
  const tileLeft = cell.bandX
  const tileTop = cell.bandY
  const tileRight = cell.bandX + cell.tileWidth
  const tileBottom = cell.bandY + cell.tileHeight
  const extRight = viewport.originX + viewport.width
  const extBottom = viewport.originY + viewport.height

  const visLeft = Math.max(tileLeft, viewport.originX)
  const visTop = Math.max(tileTop, viewport.originY)
  const visRight = Math.min(tileRight, extRight)
  const visBottom = Math.min(tileBottom, extBottom)
  const visibleW = visRight - visLeft
  const visibleH = visBottom - visTop

  if (visibleW <= 0 || visibleH <= 0) {
    return null
  }

  const clipLeft = visLeft - tileLeft
  const clipTop = visTop - tileTop

  return {
    leftPct: ((visLeft - viewport.originX) / viewport.width) * 100,
    topPct: ((visTop - viewport.originY) / viewport.height) * 100,
    widthPct: (visibleW / viewport.width) * 100,
    heightPct: (visibleH / viewport.height) * 100,
    imgLeftFrac: -(clipLeft / visibleW),
    imgTopFrac: -(clipTop / visibleH),
    imgWidthFrac: cell.tileWidth / visibleW,
    imgHeightFrac: cell.tileHeight / visibleH,
  }
}

function TilingBand({
  state,
  onTileClick,
}: {
  state: TilingState
  onTileClick: (nsIdx: number) => void
}) {
  const {
    direction,
    extensionSize,
    cells,
    tilePreviews,
    tileAccepted,
    generatingTileIdx,
    nextPendingTileIdx,
  } = state

  const isVertical = direction === 'down' || direction === 'up'
  const viewport = extensionViewport(state)

  // Round only the outer edges of the band (the shared edge with the image is flat)
  const bandRound =
    direction === 'down'
      ? 'rounded-b-[var(--radius-lg)]'
      : direction === 'up'
      ? 'rounded-t-[var(--radius-lg)]'
      : direction === 'right'
      ? 'rounded-r-[var(--radius-lg)]'
      : 'rounded-l-[var(--radius-lg)]'

  const sharedEdgeStyle: React.CSSProperties =
    direction === 'down'
      ? { borderTop: 'none' }
      : direction === 'up'
      ? { borderBottom: 'none' }
      : direction === 'right'
      ? { borderLeft: 'none' }
      : { borderRight: 'none' }

  return (
    <div
      className={`checker relative overflow-hidden ${bandRound}`}
      style={{
        // In the flex container this element grows to fill the extension flex ratio
        flex: isVertical ? extensionSize : extensionSize,
        minWidth: 0,
        minHeight: 0,
        border: '1px solid var(--border)',
        ...sharedEdgeStyle,
      }}
    >
      {cells
        .filter((c) => !c.isSkipped)
        .map((cell) => {
          const ns = cell.nonSkippedIndex
          const preview = ns >= 0 ? (tilePreviews[ns] ?? null) : null
          const isAccepted = ns >= 0 ? (tileAccepted[ns] ?? false) : false
          const isGenerating = ns === generatingTileIdx
          const isNext = ns === nextPendingTileIdx
          const hasPreview = preview !== null

          const layout = tileExtensionLayout(cell, viewport)
          if (!layout) {
            return null
          }

          const {
            leftPct,
            topPct,
            widthPct,
            heightPct,
            imgTopFrac,
            imgLeftFrac,
            imgHeightFrac,
            imgWidthFrac,
          } = layout

          const borderColor = isAccepted
            ? 'rgba(255,255,255,0.15)'
            : isNext
            ? 'var(--accent)'
            : isGenerating
            ? 'rgba(120,120,255,0.6)'
            : hasPreview
            ? 'rgba(255,255,255,0.1)'
            : 'rgba(255,255,255,0.08)'

          return (
            <div
              key={`t${ns}`}
              role="button"
              tabIndex={0}
              onClick={() => onTileClick(ns)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTileClick(ns) }}
              className={!hasPreview && !isGenerating ? 'animate-pulse' : ''}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${widthPct}%`,
                height: `${heightPct}%`,
                boxSizing: 'border-box',
                cursor: 'pointer',
                backgroundColor: isGenerating
                  ? 'rgba(80,80,130,0.45)'
                  : 'rgba(18,18,28,0.65)',
                border: `1px ${hasPreview ? 'solid' : 'dashed'} ${borderColor}`,
                boxShadow: isNext && !isAccepted ? '0 0 0 2px var(--accent)' : 'none',
                overflow: 'hidden',
                transition: 'box-shadow 0.2s, border-color 0.2s',
              }}
            >
              {/* Preview image — offset so only the extension portion shows */}
              {hasPreview && preview && (
                <img
                  src={preview}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    left: `${imgLeftFrac * 100}%`,
                    top: `${imgTopFrac * 100}%`,
                    width: `${imgWidthFrac * 100}%`,
                    height: `${imgHeightFrac * 100}%`,
                    display: 'block',
                    pointerEvents: 'none',
                  }}
                />
              )}

              {/* Accepted checkmark */}
              {isAccepted && (
                <div
                  className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
                  style={{ background: 'var(--accent)', color: 'white', pointerEvents: 'none' }}
                >
                  ✓
                </div>
              )}

              {/* Generating spinner */}
              {isGenerating && !hasPreview && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Icons.Spinner size={18} />
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TilingEdgeControl — pill with Pre-approve/Approve-each toggle + cancel,
// overlapping the image edge (same position family as EdgeHandle)
// ─────────────────────────────────────────────────────────────────────────────

function TilingEdgeControl({
  direction,
  onCancel,
}: {
  direction: Direction
  onCancel: () => void
}) {
  const position: React.CSSProperties = (
    {
      up: { top: -20, left: '50%', transform: 'translateX(-50%)' },
      down: { bottom: -20, left: '50%', transform: 'translateX(-50%)' },
      left: { left: -20, top: '50%', transform: 'translateY(-50%)' },
      right: { right: -20, top: '50%', transform: 'translateY(-50%)' },
    } as Record<Direction, React.CSSProperties>
  )[direction]

  return (
    <div
      className="absolute z-10 flex items-center gap-1.5 whitespace-nowrap"
      style={position}
    >
      <button
        onClick={onCancel}
        title="Cancel tiled extension"
        className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent)'
          e.currentTarget.style.color = 'var(--accent)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-strong)'
          e.currentTarget.style.color = 'var(--text-secondary)'
        }}
      >
        <Icons.X size={13} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EdgeHandle — single-direction extend button (used in normal / non-tiling mode)
// ─────────────────────────────────────────────────────────────────────────────

export function EdgeHandle({
  direction,
  onClick,
  active,
  disabled,
}: {
  direction: Direction
  onClick: (d: Direction) => void
  active: boolean
  disabled: boolean
}) {
  const Icon = {
    up: Icons.ArrowUp,
    down: Icons.ArrowDown,
    left: Icons.ArrowLeft,
    right: Icons.ArrowRight,
  }[direction]

  const position: React.CSSProperties = (
    {
      up: { top: -22, left: '50%', transform: 'translateX(-50%)' },
      down: { bottom: -22, left: '50%', transform: 'translateX(-50%)' },
      left: { left: -22, top: '50%', transform: 'translateY(-50%)' },
      right: { right: -22, top: '50%', transform: 'translateY(-50%)' },
    } as Record<Direction, React.CSSProperties>
  )[direction]

  return (
    <button
      onClick={() => onClick(direction)}
      disabled={disabled}
      title={`Extend ${direction}`}
      aria-label={`Extend ${direction}`}
      className={`group absolute z-10 flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 ${
        active ? 'anim-pulse' : ''
      }`}
      style={{
        ...position,
        background: active ? 'var(--accent)' : 'var(--bg-elev)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
        color: active ? '#1a1404' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !active ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.borderColor = 'var(--accent)'
        e.currentTarget.style.color = active ? '#1a1404' : 'var(--accent)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = active
          ? 'var(--accent)'
          : 'var(--border-strong)'
        e.currentTarget.style.color = active ? '#1a1404' : 'var(--text-secondary)'
      }}
    >
      <Icon size={18} />
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace — image frame with edge handles, tiling band, and meta row
// ─────────────────────────────────────────────────────────────────────────────

export function Workspace({
  image,
  dimensions,
  onExtend,
  activeDirection,
  loading,
  progressMessage,
  isResult,
  resultMessage,
  variantSelector,
  resultActions,
  tilingState,
  onTileClick,
  onTileCancel,
}: {
  image: string
  dimensions: { width: number; height: number } | null
  onExtend: (d: Direction) => void
  activeDirection: Direction | null
  loading: boolean
  progressMessage?: string | null
  isResult: boolean
  resultMessage?: string
  /**
   * Optional cycle-between-variants control rendered next to the dimension
   * pill. Only shown when the current extension produced more than one
   * candidate.
   */
  variantSelector?: React.ReactNode
  resultActions?: React.ReactNode
  /** When set, renders the inline tiling band instead of the normal extend arrows. */
  tilingState?: TilingState | null
  /** Called when the user clicks a non-skipped tile cell in the band. */
  onTileClick?: (nsIdx: number) => void
  onTileCancel?: () => void
}) {
  const isTiling = !!tilingState

  // ── Layout helpers when tiling ──────────────────────────────────────────────
  const flexDir: React.CSSProperties['flexDirection'] =
    tilingState?.direction === 'down'
      ? 'column'
      : tilingState?.direction === 'up'
      ? 'column-reverse'
      : tilingState?.direction === 'right'
      ? 'row'
      : 'row-reverse'

  const isVertical =
    tilingState?.direction === 'down' || tilingState?.direction === 'up'

  /**
   * Combined aspect-ratio of the image + extension band for the container.
   * The browser keeps both max-h and max-w respected while maintaining this ratio.
   */
  const combinedAspectRatio = tilingState
    ? isVertical
      ? `${tilingState.imageWidth} / ${tilingState.imageHeight + tilingState.extensionSize}`
      : `${tilingState.imageWidth + tilingState.extensionSize} / ${tilingState.imageHeight}`
    : undefined

  /**
   * Flex-basis values for image and band inside the combined container.
   * We use unitless `flex` (grow) numbers in the same ratio as the pixel sizes
   * so each child fills its proportional share of the container.
   */
  const imageFlex = tilingState
    ? isVertical
      ? tilingState.imageHeight
      : tilingState.imageWidth
    : undefined

  // Round only the corner(s) of the image that face away from the band.
  const imageRound = tilingState
    ? {
        down: 'rounded-t-[var(--radius-lg)]',
        up: 'rounded-b-[var(--radius-lg)]',
        right: 'rounded-l-[var(--radius-lg)]',
        left: 'rounded-r-[var(--radius-lg)]',
      }[tilingState.direction]
    : 'rounded-[var(--radius-lg)]'

  const imageSharedEdgeStyle: React.CSSProperties = tilingState
    ? ({
        down: { borderBottom: 'none' },
        up: { borderTop: 'none' },
        right: { borderRight: 'none' },
        left: { borderLeft: 'none' },
      } as Record<Direction, React.CSSProperties>)[tilingState.direction]
    : {}

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 pb-6 pt-2">
      {/* ── Image frame (with optional tiling band) ──────────────────────── */}
      <div
        className="relative anim-fade"
        style={
          isTiling
            ? {
                display: 'flex',
                flexDirection: flexDir,
                aspectRatio: combinedAspectRatio,
                maxHeight: 'calc(100vh - 260px)',
                maxWidth: 'min(1200px, calc(100vw - 96px))',
              }
            : undefined
        }
      >
        {/* Active-direction edge glow (non-tiling only) */}
        {activeDirection && !isTiling && (
          <div
            className={`pointer-events-none absolute inset-0 rounded-[var(--radius-lg)] edge-glow-${activeDirection}`}
          />
        )}

        {/* Image container */}
        <div
          className={`relative overflow-hidden checker ${imageRound}`}
          style={{
            ...(isTiling
              ? {
                  flex: imageFlex,
                  minWidth: 0,
                  minHeight: 0,
                  border: '1px solid var(--border)',
                  boxShadow:
                    '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
                  ...imageSharedEdgeStyle,
                }
              : {
                  border: '1px solid var(--border)',
                  boxShadow:
                    '0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4)',
                }),
          }}
        >
          <img
            src={image}
            alt=""
            className={`block object-contain anim-fade ${
              isTiling
                ? 'h-full w-full'
                : 'max-h-[calc(100vh-260px)] max-w-[min(1200px,calc(100vw-96px))]'
            }`}
            draggable={false}
          />
        </div>

        {/* Inline tile band (tiling mode) */}
        {tilingState && (
          <TilingBand
            state={tilingState}
            onTileClick={onTileClick ?? (() => undefined)}
          />
        )}

        {/* Edge controls: tiling mode shows cancel on active direction only;
            normal mode shows extend arrows on all four sides. */}
        {isTiling
          ? (
            <TilingEdgeControl
              direction={tilingState.direction}
              onCancel={onTileCancel ?? (() => undefined)}
            />
          )
          : !isResult && (
              <>
                <EdgeHandle
                  direction="up"
                  onClick={onExtend}
                  active={activeDirection === 'up'}
                  disabled={loading}
                />
                <EdgeHandle
                  direction="down"
                  onClick={onExtend}
                  active={activeDirection === 'down'}
                  disabled={loading}
                />
                <EdgeHandle
                  direction="left"
                  onClick={onExtend}
                  active={activeDirection === 'left'}
                  disabled={loading}
                />
                <EdgeHandle
                  direction="right"
                  onClick={onExtend}
                  active={activeDirection === 'right'}
                  disabled={loading}
                />
              </>
            )}
      </div>

      {/* ── Below-image meta row ─────────────────────────────────────────── */}
      <div className="mt-5 flex items-center gap-3 anim-slide-up">
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
        {isResult && variantSelector}
        {isResult && resultMessage && (
          <StatusPill status="ok" message={resultMessage} />
        )}
        {isTiling && tilingState.generatingTileIdx !== null && progressMessage && (
          <StatusPill status="working" message={progressMessage} />
        )}
        {isTiling && tilingState.nextPendingTileIdx !== null && tilingState.generatingTileIdx === null && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Click tile {tilingState.nextPendingTileIdx + 1} to generate
          </span>
        )}
        {!isResult && !loading && !isTiling && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Click an edge to extend
          </span>
        )}
        {resultActions && isResult && resultActions}
      </div>
    </div>
  )
}
