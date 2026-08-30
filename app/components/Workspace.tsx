'use client'

import { useState } from 'react'
import { Icons } from '@/app/components/icons'
import { PlanOptionCycler } from '@/app/components/Modals'
import { ReferenceGridOverlay } from '@/app/components/ReferenceGridOverlay'
import { StatusPill } from '@/app/components/TopBar'
import { Direction, PLAN_VARIANT_COUNT } from '@/app/lib/app'

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

/** Minimal per-cell data the inline region-layer overlay needs. */
export interface RegionCellDisplay {
  index: number
  bandX: number
  bandY: number
  width: number
  height: number
  /** True once this region has a generated plan result. */
  hasResult: boolean
  /** True while this specific region's plan call is in flight. */
  isGenerating: boolean
  /** True if at least one of this region's owned tiles is now stale. */
  hasStaleTiles: boolean
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
  /** Global low-res plan result (Phase 1 output), shown as band background. */
  globalPlanResult?: string | null
  /** Extension-only crop of the global plan — preferred for band background. */
  globalPlanExtensionView?: string | null
  /** True while Phase 1 (global plan) is being generated. */
  isGlobalPlanGenerating?: boolean
  /** How many Phase-1 global plan options exist (0 if none yet). */
  globalPlanOptionCount?: number
  /** Selected Phase-1 global plan option index. */
  globalPlanOptionIdx?: number
  /**
   * Region-layer cells for a regionally-planned (very large) extension.
   * Undefined/empty when the extension uses a single whole-scene plan —
   * the region layer toggle only appears when this is non-empty.
   */
  regions?: RegionCellDisplay[]
  /** Per-tile "stale" flags — owning region was regenerated after this tile had a result. */
  staleTileIds?: Set<number>
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

/** Map a band-coordinate rect's intersection with the extension viewport to band-UI percentages. */
function rectExtensionLayout(
  rect: { bandX: number; bandY: number; width: number; height: number },
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
  const rectLeft = rect.bandX
  const rectTop = rect.bandY
  const rectRight = rect.bandX + rect.width
  const rectBottom = rect.bandY + rect.height
  const extRight = viewport.originX + viewport.width
  const extBottom = viewport.originY + viewport.height

  const visLeft = Math.max(rectLeft, viewport.originX)
  const visTop = Math.max(rectTop, viewport.originY)
  const visRight = Math.min(rectRight, extRight)
  const visBottom = Math.min(rectBottom, extBottom)
  const visibleW = visRight - visLeft
  const visibleH = visBottom - visTop

  if (visibleW <= 0 || visibleH <= 0) {
    return null
  }

  const clipLeft = visLeft - rectLeft
  const clipTop = visTop - rectTop

  return {
    leftPct: ((visLeft - viewport.originX) / viewport.width) * 100,
    topPct: ((visTop - viewport.originY) / viewport.height) * 100,
    widthPct: (visibleW / viewport.width) * 100,
    heightPct: (visibleH / viewport.height) * 100,
    imgLeftFrac: -(clipLeft / visibleW),
    imgTopFrac: -(clipTop / visibleH),
    imgWidthFrac: rect.width / visibleW,
    imgHeightFrac: rect.height / visibleH,
  }
}

/** Map a tile's intersection with the extension viewport to band-UI percentages. */
function tileExtensionLayout(
  cell: TileCellDisplay,
  viewport: ExtensionViewport,
) {
  return rectExtensionLayout(
    { bandX: cell.bandX, bandY: cell.bandY, width: cell.tileWidth, height: cell.tileHeight },
    viewport,
  )
}

function TilingBand({
  state,
  onTileClick,
  onRegionClick,
  activeLayer,
}: {
  state: TilingState
  onTileClick: (nsIdx: number) => void
  onRegionClick?: (regionIdx: number) => void
  /** Which grid is bold/interactive; the other renders faint/dashed. */
  activeLayer: 'tiles' | 'regions'
}) {
  const {
    direction,
    extensionSize,
    cells,
    tilePreviews,
    tileAccepted,
    generatingTileIdx,
    nextPendingTileIdx,
    globalPlanExtensionView,
    regions,
    staleTileIds,
  } = state

  const isVertical = direction === 'down' || direction === 'up'
  const viewport = extensionViewport(state)
  const hasRegions = !!regions && regions.length > 0
  const tilesActive = !hasRegions || activeLayer === 'tiles'
  const regionsActive = hasRegions && activeLayer === 'regions'

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
      {/* Global plan background — pre-cropped extension view, no CSS offset needed */}
      {globalPlanExtensionView && (
        <img
          src={globalPlanExtensionView}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'fill',
            pointerEvents: 'none',
            opacity: 0.85,
          }}
        />
      )}

      {cells
        .filter((c) => !c.isSkipped)
        .map((cell) => {
          const ns = cell.nonSkippedIndex
          const preview = ns >= 0 ? (tilePreviews[ns] ?? null) : null
          const isAccepted = ns >= 0 ? (tileAccepted[ns] ?? false) : false
          const isGenerating = ns === generatingTileIdx
          const isNext = ns === nextPendingTileIdx
          const hasPreview = preview !== null
          const isStale = ns >= 0 && !!staleTileIds?.has(ns)

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
              tabIndex={tilesActive ? 0 : -1}
              onClick={() => { if (tilesActive) onTileClick(ns) }}
              onKeyDown={(e) => { if (tilesActive && (e.key === 'Enter' || e.key === ' ')) onTileClick(ns) }}
              className={!hasPreview && !isGenerating && tilesActive ? 'animate-pulse' : ''}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${widthPct}%`,
                height: `${heightPct}%`,
                boxSizing: 'border-box',
                cursor: tilesActive ? 'pointer' : 'default',
                opacity: tilesActive ? 1 : 0.35,
                pointerEvents: tilesActive ? 'auto' : 'none',
                backgroundColor: isGenerating
                  ? 'rgba(80,80,130,0.45)'
                  : 'rgba(18,18,28,0.65)',
                border: `1px ${hasPreview ? 'solid' : 'dashed'} ${borderColor}`,
                boxShadow: tilesActive && isNext && !isAccepted ? '0 0 0 2px var(--accent)' : 'none',
                overflow: 'hidden',
                transition: 'box-shadow 0.2s, border-color 0.2s, opacity 0.2s',
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
                    // Override Tailwind preflight (max-width: 100%; height: auto) so
                    // imgWidthFrac/imgHeightFrac can exceed 100% for extension clipping.
                    maxWidth: 'none',
                    objectFit: 'fill',
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

              {/* Stale badge — owning region was regenerated after this tile had a result */}
              {isStale && (
                <div
                  className="absolute top-1 left-1 rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide"
                  style={{ background: 'rgba(230,160,20,0.9)', color: '#1a1404', pointerEvents: 'none' }}
                  title="This tile's plan changed — regenerate to catch up"
                >
                  Stale
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

      {/* Region layer overlay — faint/dashed context when tiles are active,
          bold and clickable when the user has switched to the region layer. */}
      {hasRegions && regions!.map((region) => {
        const layout = rectExtensionLayout(
          { bandX: region.bandX, bandY: region.bandY, width: region.width, height: region.height },
          viewport,
        )
        if (!layout) return null
        const { leftPct, topPct, widthPct, heightPct } = layout

        const borderColor = region.isGenerating
          ? 'rgba(120,120,255,0.8)'
          : region.hasStaleTiles
          ? 'rgba(230,160,20,0.9)'
          : region.hasResult
          ? 'var(--accent)'
          : 'rgba(255,255,255,0.5)'

        return (
          <div
            key={`r${region.index}`}
            role="button"
            tabIndex={regionsActive ? 0 : -1}
            onClick={() => { if (regionsActive) onRegionClick?.(region.index) }}
            onKeyDown={(e) => {
              if (regionsActive && (e.key === 'Enter' || e.key === ' ')) onRegionClick?.(region.index)
            }}
            style={{
              position: 'absolute',
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${widthPct}%`,
              height: `${heightPct}%`,
              boxSizing: 'border-box',
              cursor: regionsActive ? 'pointer' : 'default',
              pointerEvents: regionsActive ? 'auto' : 'none',
              border: `2px ${region.hasResult ? 'solid' : 'dashed'} ${borderColor}`,
              opacity: regionsActive ? 1 : 0.4,
              transition: 'opacity 0.2s, border-color 0.2s',
            }}
          >
            <div
              className="absolute top-1 left-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
              style={{ background: 'rgba(18,18,28,0.75)', color: 'var(--text-secondary)', pointerEvents: 'none' }}
            >
              {region.isGenerating ? <Icons.Spinner size={9} /> : `R${region.index + 1}`}
            </div>
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
  onRerunGlobalPlan,
  isGlobalPlanGenerating,
  globalPlanOptionCount,
  globalPlanOptionIdx,
  onCycleGlobalPlan,
  onGenerateAll,
  isAutoGenerating,
  onStopAutoGenerate,
  canGenerateAll,
  hasRegions,
  activeLayer,
  onLayerChange,
  regionCount,
}: {
  direction: Direction
  onCancel: () => void
  onRerunGlobalPlan?: () => void
  isGlobalPlanGenerating?: boolean
  /** How many Phase-1 global plan options exist (0 if none yet). */
  globalPlanOptionCount?: number
  /** Selected Phase-1 global plan option index. */
  globalPlanOptionIdx?: number
  /** Cycle Phase-1 global plan options (also bound to ← → on the workspace). */
  onCycleGlobalPlan?: (delta: 1 | -1) => void
  /** Kick off automatic sequential generation for the active layer. */
  onGenerateAll?: () => void
  /** True while the "Generate all" loop is running. */
  isAutoGenerating?: boolean
  /** Stop the "Generate all" loop after the current step finishes. */
  onStopAutoGenerate?: () => void
  /** Whether at least one item on the active layer is still left to generate. */
  canGenerateAll?: boolean
  /** True for a regionally-planned (very large) extension — shows the layer toggle. */
  hasRegions?: boolean
  activeLayer?: 'tiles' | 'regions'
  onLayerChange?: (layer: 'tiles' | 'regions') => void
  regionCount?: number
}) {
  const position: React.CSSProperties = (
    {
      up: { top: -20, left: '50%', transform: 'translateX(-50%)' },
      down: { bottom: -20, left: '50%', transform: 'translateX(-50%)' },
      left: { left: -20, top: '50%', transform: 'translateY(-50%)' },
      right: { right: -20, top: '50%', transform: 'translateY(-50%)' },
    } as Record<Direction, React.CSSProperties>
  )[direction]

  const pillBtnStyle: React.CSSProperties = {
    background: 'var(--bg-elev)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-secondary)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  }

  const pillBtnHoverEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.borderColor = 'var(--accent)'
    e.currentTarget.style.color = 'var(--accent)'
  }
  const pillBtnHoverLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.borderColor = 'var(--border-strong)'
    e.currentTarget.style.color = 'var(--text-secondary)'
  }

  return (
    <div
      className="absolute z-10 flex items-center gap-1.5 whitespace-nowrap"
      style={position}
    >
      {/* Layer toggle — only shown for regionally-planned (very large) extensions,
          so it's always visually unambiguous which grid a click will hit. */}
      {hasRegions && onLayerChange && (
        <div
          className="flex items-center rounded-full p-0.5"
          style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-strong)', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}
        >
          {(['regions', 'tiles'] as const).map((layer) => (
            <button
              key={layer}
              onClick={() => onLayerChange(layer)}
              title={layer === 'regions' ? `${regionCount ?? 0} region${regionCount === 1 ? '' : 's'}` : 'Tiles'}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                background: activeLayer === layer ? 'var(--accent)' : 'transparent',
                color: activeLayer === layer ? '#1a1404' : 'var(--text-secondary)',
              }}
            >
              {layer === 'regions' ? `Regions${typeof regionCount === 'number' ? ` (${regionCount})` : ''}` : 'Tiles'}
            </button>
          ))}
        </div>
      )}

      {/* Re-run global plan — only shown when the callback is provided */}
      {onRerunGlobalPlan && (
        <button
          onClick={onRerunGlobalPlan}
          disabled={isGlobalPlanGenerating || isAutoGenerating}
          title={isGlobalPlanGenerating ? 'Generating global plan…' : 'Re-run global plan'}
          className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
          style={{
            ...pillBtnStyle,
            opacity: isGlobalPlanGenerating || isAutoGenerating ? 0.6 : 1,
          }}
          onMouseEnter={pillBtnHoverEnter}
          onMouseLeave={pillBtnHoverLeave}
        >
          {isGlobalPlanGenerating
            ? <Icons.Spinner size={13} />
            : <Icons.Refresh size={13} />
          }
        </button>
      )}

      {globalPlanOptionCount !== undefined && globalPlanOptionCount > 1 && onCycleGlobalPlan ? (
        <PlanOptionCycler
          index={globalPlanOptionIdx ?? 0}
          total={PLAN_VARIANT_COUNT}
          disabled={!!isGlobalPlanGenerating || !!isAutoGenerating}
          onPrev={() => onCycleGlobalPlan(-1)}
          onNext={() => onCycleGlobalPlan(1)}
        />
      ) : null}

      {/* Generate all — on the Regions layer this plans remaining regions
          only; on the Tiles layer it generates remaining tiles. */}
      {onGenerateAll && (
        <button
          onClick={isAutoGenerating ? onStopAutoGenerate : onGenerateAll}
          disabled={!isAutoGenerating && !canGenerateAll}
          title={
            isAutoGenerating
              ? hasRegions && activeLayer === 'regions'
                ? 'Stop generating regions'
                : 'Stop generating tiles'
              : canGenerateAll
              ? hasRegions && activeLayer === 'regions'
                ? 'Generate all remaining regions'
                : 'Generate all remaining tiles automatically'
              : hasRegions && activeLayer === 'regions'
              ? 'All regions generated'
              : 'All tiles generated'
          }
          className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
          style={{
            ...pillBtnStyle,
            opacity: !isAutoGenerating && !canGenerateAll ? 0.4 : 1,
          }}
          onMouseEnter={pillBtnHoverEnter}
          onMouseLeave={pillBtnHoverLeave}
        >
          {isAutoGenerating ? <Icons.Stop size={13} /> : <Icons.Play size={13} />}
        </button>
      )}

      <button
        onClick={onCancel}
        title="Cancel tiled extension"
        className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
        style={pillBtnStyle}
        onMouseEnter={pillBtnHoverEnter}
        onMouseLeave={pillBtnHoverLeave}
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
  onRegionClick,
  onTileCancel,
  onRerunGlobalPlan,
  onCycleGlobalPlan,
  onGenerateAllTiles,
  onGenerateAllRegions,
  isAutoGeneratingTiles,
  onStopAutoGenerateTiles,
  showGrid = false,
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
  /** Called when the user clicks a region cell in the region layer. */
  onRegionClick?: (regionIdx: number) => void
  onTileCancel?: () => void
  /** Re-run Phase 1 (global plan) for the entire extension. */
  onRerunGlobalPlan?: () => void
  /** Cycle Phase-1 global plan options. */
  onCycleGlobalPlan?: (delta: 1 | -1) => void
  /** Sequentially generate + auto-accept every remaining tile (Tiles layer). */
  onGenerateAllTiles?: () => void
  /** Sequentially plan every remaining region and stop (Regions layer). */
  onGenerateAllRegions?: () => void
  /** True while the "Generate all" loop is running. */
  isAutoGeneratingTiles?: boolean
  /** Stop the "Generate all" loop after the current step finishes. */
  onStopAutoGenerateTiles?: () => void
  /** Paint the 1000×1000 reference grid over the image (and tiling band). */
  showGrid?: boolean
}) {
  const isTiling = !!tilingState
  const hasRegions = !!tilingState?.regions && tilingState.regions.length > 0
  /**
   * Which grid is bold/interactive. Play is scoped to this layer: Regions
   * plans remaining regions only; Tiles generates remaining tiles (based on
   * those region plans). Defaults to tiles so a user who never opens the
   * region layer still gets the existing generate-all-tiles path.
   */
  const [activeLayer, setActiveLayer] = useState<'tiles' | 'regions'>('tiles')
  const regionsLayerSelected = hasRegions && activeLayer === 'regions'
  const canGenerateAll = regionsLayerSelected
    ? !!tilingState?.regions?.some((region) => !region.hasResult)
    : tilingState?.nextPendingTileIdx !== null

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

  const gridWidth = tilingState
    ? isVertical
      ? tilingState.imageWidth
      : tilingState.imageWidth + tilingState.extensionSize
    : dimensions?.width ?? 0
  const gridHeight = tilingState
    ? isVertical
      ? tilingState.imageHeight + tilingState.extensionSize
      : tilingState.imageHeight
    : dimensions?.height ?? 0

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
          {!isTiling && showGrid && gridWidth > 0 && gridHeight > 0 ? (
            <ReferenceGridOverlay width={gridWidth} height={gridHeight} />
          ) : null}
        </div>

        {isTiling && showGrid && gridWidth > 0 && gridHeight > 0 ? (
          <ReferenceGridOverlay width={gridWidth} height={gridHeight} />
        ) : null}

        {/* Inline tile band (tiling mode) */}
        {tilingState && (
          <TilingBand
            state={tilingState}
            onTileClick={
              isAutoGeneratingTiles ? () => undefined : onTileClick ?? (() => undefined)
            }
            onRegionClick={
              isAutoGeneratingTiles ? undefined : onRegionClick
            }
            activeLayer={hasRegions ? activeLayer : 'tiles'}
          />
        )}

        {/* Edge controls: tiling mode shows cancel on active direction only;
            normal mode shows extend arrows on all four sides. */}
        {isTiling
          ? (
            <TilingEdgeControl
              direction={tilingState.direction}
              onCancel={onTileCancel ?? (() => undefined)}
              onRerunGlobalPlan={onRerunGlobalPlan}
              isGlobalPlanGenerating={tilingState.isGlobalPlanGenerating}
              globalPlanOptionCount={tilingState.globalPlanOptionCount}
              globalPlanOptionIdx={tilingState.globalPlanOptionIdx}
              onCycleGlobalPlan={onCycleGlobalPlan}
              onGenerateAll={
                regionsLayerSelected ? onGenerateAllRegions : onGenerateAllTiles
              }
              isAutoGenerating={isAutoGeneratingTiles}
              onStopAutoGenerate={onStopAutoGenerateTiles}
              canGenerateAll={canGenerateAll}
              hasRegions={hasRegions}
              activeLayer={activeLayer}
              onLayerChange={setActiveLayer}
              regionCount={tilingState.regions?.length}
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
