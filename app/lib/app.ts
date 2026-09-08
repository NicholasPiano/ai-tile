'use client'

export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * One generated extension result. Simple (single-tile) extends produce
 * {@link EXTEND_VARIANT_COUNT} candidates in parallel. Horizontal results
 * are sorted by seam quality (lowest residual first); the user cycles
 * before accepting.
 */

export type Candidate = {
  /**
   * Fully blended, ready-to-display image data URL. For parallax keyed
   * layers, this is the alpha-keyed (transparent-magenta) version.
   */
  imageUrl: string
  /** Mean color difference at the seam — lower = cleaner blend. */
  score: number
  /** 1-indexed generation order, useful for debug logging. */
  attempt: number
  /**
   * Pre-keying source for parallax keyed layers. Stored so the next extend
   * operation can feed the un-keyed magenta image back into the AI (the
   * model continues the magenta background more reliably than transparent
   * regions). Undefined for sky layers and for extender-mode candidates.
   */
  rawImageUrl?: string
}

/**
 * Extension percent is fixed in code. 38% is the sweet spot we converged on —
 * large enough to feel useful, small enough that the AI keeps the scene
 * coherent. Iterative extensions chain naturally if the user wants more.
 */

export const EXTENSION_PERCENT = 38

/**
 * Maximum pixel dimension (width or height) sent to the AI in a single call.
 * Images/chunks larger than this are scaled before the API call and the result
 * is scaled back up.  Tiled extends use full-res tiles that individually fit
 * within this cap instead of downscaling.
 */
export const MAX_AI_DIMENSION = 1536

/**
 * Overlap in pixels between adjacent tiles in a tiled extension.
 * Each tile's input includes this many already-generated pixels from its
 * processed neighbors so the AI continues the scene coherently, and the
 * compositor feathers the join over this width.
 */
export const TILE_OVERLAP_PX = 384

/**
 * Hard cap on the total number of API calls per tiled extension to guard
 * against accidental runaway cost on very large images. Each non-skipped
 * tile costs up to two calls (Phase 2 re-plan + Phase 3 refine), so this
 * is a coarse cost/time guard rather than a technical limit — raise it if
 * you routinely extend very large images and are fine with the extra calls.
 */
export const MAX_TILES_PER_EXTEND = 36

/**
 * Longest edge of every plan-level image (global plan, regional plans,
 * per-tile re-plans). Reuses the same ceiling the AI API accepts for a
 * single call (`MAX_AI_DIMENSION`) — there is no cost or API reason to send
 * a smaller image than the model can accept, so plans get the full budget.
 * (A separate, smaller `PLANNING_MAP_MAX_DIM` constant used to cap this at
 * 1024px; it has been retired in favour of `MAX_AI_DIMENSION`.)
 */

/**
 * Multiplier applied to `MAX_AI_DIMENSION` to decide when a single whole-scene
 * plan is too compressed to be useful and the extension should instead be
 * planned as multiple overlapping regional plans (see `groupTilesIntoPlanRegions`
 * in imageProcessor.ts). E.g. with a multiplier of 2, a scene whose longest
 * edge exceeds 3072px (2 × 1536) switches to regional planning.
 */
export const REGIONAL_PLAN_TRIGGER_MULTIPLIER = 2

/**
 * Target maximum scene-space span (in source-image pixels, before scaling)
 * that a single regional plan should cover per axis. Regions are grouped from
 * the tile grid so each region's bounding rect stays under this before being
 * scaled to `MAX_AI_DIMENSION` — smaller regions of a huge scene render with
 * far less compression than a single whole-scene plan would.
 *
 * Deliberately biased toward fewer, larger (more downscaled/blurry) regions
 * rather than more, sharper ones: a regional plan's whole job is coherence —
 * getting the broad composition right so Phase 3 tile refine has something
 * sensible to sharpen — not fine detail, so it's fine for it to be blurry.
 * Fewer regions means fewer plan-to-plan seams to keep consistent.
 */
export const PLAN_REGION_MAX_SCENE_DIM = 8192

/**
 * Number of tiles shared between two adjacent regions. The shared tiles'
 * content is decided once (by the earlier region) and carried forward as
 * real, already-decided pixels into the later region's input — the same
 * overlap/continuity trick tiles already use with `TILE_OVERLAP_PX`, applied
 * one level up between regions. A larger overlap gives the model more real
 * (already-decided) pixels to anchor each region's continuation against,
 * trading a bit more per-region compression for much better plan-to-plan
 * coherence.
 */
export const PLAN_REGION_OVERLAP_TILES = 3

/**
 * Hard cap on the number of regional plan calls per extension, guarding
 * against runaway cost on pathological image sizes — mirrors
 * `MAX_TILES_PER_EXTEND` above.
 */
export const MAX_PLAN_REGIONS = 24

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter integration — BYOK (bring your own key) for open-source friendliness
// ─────────────────────────────────────────────────────────────────────────────


export const STORAGE_KEY = 'extender:api_key'

export const STORAGE_MODEL = 'extender:model'

// ─────────────────────────────────────────────────────────────────────────────
// Inline icons — minimal SVG primitives, zero dependencies
// ─────────────────────────────────────────────────────────────────────────────


export type Mode = 'extender' | 'edit' | 'parallax' | 'tile' | 'sprite' | 'props'

/**
 * Minimum strip of original image pixels that surrounds every edit selection.
 * This context border is sent to the inpaint model so it can match the
 * surrounding scene.
 */
export const EDIT_STRIP_PX = 256

/**
 * Longest edge (in pixels) of the low-resolution global plan image sent to
 * the LLM in the first stage of the tiled inpaint pipeline. Slightly below
 * the 1536 MAX_AI_DIMENSION to leave a small safety margin.
 */
export const GLOBAL_PLAN_MAX_DIM = 1356

/**
 * A single user-supplied reference image attached to a tile extension call.
 * The data URL is sent as an additional image_url part in the model request;
 * the description is relayed in the prompt so the model understands the image's
 * intended role.
 */
export type ReferenceImage = {
  /** Base-64 data URL of the image (data:image/…;base64,…). */
  dataUrl: string
  /** Optional human-readable note about what the image represents. */
  description: string
}

/**
 * Snapshot of one `/api/extend` call for Debug-mode inspection: the exact
 * IMAGE 1 canvas sent to the model plus the assembled prompt text returned
 * by the server (or a client-side rebuild if the response omitted it).
 */
export type LlmRequestDebug = {
  /** Short UI label, e.g. "Phase 1 — Global plan". */
  label: string
  phase: 'plan' | 'refine'
  /** Set when this was a regional plan call. */
  planScope?: 'region'
  /** Working-canvas data URL (IMAGE 1). */
  imageDataUrl: string
  /** Full text prompt sent as the final content part. */
  prompt: string
  /** Extra reference images included in the same request (may be empty). */
  referenceImages: ReferenceImage[]
  /**
   * Raw model output image (before client normalize/crop/lock-paste), when
   * the call succeeded. Null/undefined if the request failed before an image
   * came back.
   */
  responseImageDataUrl?: string | null
  /** Natural pixel size of `responseImageDataUrl` (before any client resize). */
  responseImageWidth?: number
  responseImageHeight?: number
  /** Pixel size of `imageDataUrl` (the plan prototype / working canvas sent). */
  imageWidth?: number
  imageHeight?: number
  /** `Date.now()` when this snapshot was stored. */
  capturedAt: number
}

export const STORAGE_MODE = 'extender:mode'

/** Whether the 1000×1000 reference grid overlay is visible / baked on Save. */
export const STORAGE_SHOW_GRID = 'extender:show_grid'

/**
 * Build a filesystem-safe timestamp for download filenames
 * (e.g. `2026-07-13_14-11-05`). Shared by Edit Save and Extend Download.
 */
export function timestampForFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiled Inpaint Pipeline — shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User-defined region for inpainting — the drawn selection and its derived
 * context perimeter.
 */
export interface InpaintRegion {
  /** Selection drawn by the user, in image-pixel coordinates. */
  selectionRect: { x: number; y: number; w: number; h: number }
  /** Context perimeter bounding rect in image-pixel coordinates. */
  contextRect: { x: number; y: number; w: number; h: number }
}

/** Phases of the tiled inpaint workflow managed by EditStudio. */
export type InpaintPhase =
  | 'input'     // awaiting user description + reference images
  | 'planning'  // global low-res plan LLM call in progress
  | 'tiling'    // per-tile high-res refinement — idle between tiles
  | 'done'      // all tiles complete (or fast-path plan accepted); awaiting Accept / Discard

/**
 * One tile in the 2-D inpaint grid.  Position and size are in context-perimeter
 * coordinates (origin = top-left of contextRect).
 */
export interface InpaintTileSpec {
  row: number
  col: number
  totalRows: number
  totalCols: number
  /** Top-left in context-perimeter coordinates. */
  x: number
  y: number
  /** Pixel dimensions of this tile. */
  w: number
  h: number
  /** Feather overlap in pixels per edge (0 = no feather on that edge). */
  featherOverlap: { top: number; bottom: number; left: number; right: number }
  /**
   * Intersection of the user's selection with this tile, in tile-local
   * coordinates. Null when the tile lies entirely outside the selection —
   * these tiles are pure context and the API call is skipped.
   */
  maskSubRect: { x: number; y: number; w: number; h: number } | null
}

/** Tile plan produced by planInpaintTiles. */
export interface InpaintTilePlan {
  tiles: InpaintTileSpec[]
  /** Pixel width of the context perimeter canvas. */
  contextW: number
  /** Pixel height of the context perimeter canvas. */
  contextH: number
}

/** How many independent plan variants Generate produces. */
export const INPAINT_VARIANT_COUNT = 4

/**
 * How many options a global plan, region plan, or per-tile re-plan produces.
 */
export const PLAN_VARIANT_COUNT = 4

/**
 * How many free add-detail refine samples each Edit / Extend tile produces.
 */
export const TILE_REFINE_VARIANT_COUNT = 4

/**
 * How many candidates a simple (non-tiled) horizontal or vertical extend
 * generates in parallel so the user can pick.
 */
export const EXTEND_VARIANT_COUNT = 4

/**
 * Empty option list for one region, global-plan, or tile-plan slot.
 */
export function createEmptyPlanVersions(): Array<string | null> {
  return Array.from({ length: PLAN_VARIANT_COUNT }, () => null)
}

/**
 * Empty refine-version list for one tile (four null slots).
 */
export function createEmptyTileRefineVersions(): Array<string | null> {
  return Array.from({ length: TILE_REFINE_VARIANT_COUNT }, () => null)
}

/**
 * One tile's refine results: up to {@link TILE_REFINE_VARIANT_COUNT} samples
 * plus which one is stamped into the Accept canvas.
 */
export interface InpaintTileSlot {
  versions: Array<string | null>
  selectedIdx: number
}

/**
 * One empty refine slot (four null versions, selection at 0).
 */
export function createEmptyInpaintTileSlot(): InpaintTileSlot {
  return {
    versions: createEmptyTileRefineVersions(),
    selectedIdx: 0,
  }
}

/**
 * Empty refine slots for every tile in the shared grid.
 */
export function createEmptyInpaintTileSlots(tileCount: number): InpaintTileSlot[] {
  return Array.from({ length: tileCount }, () => createEmptyInpaintTileSlot())
}

/**
 * The selected refine URL for a tile slot, or null if none yet.
 */
export function selectedTileResultUrl(
  slot: InpaintTileSlot | string | null | undefined,
): string | null {
  if (slot === null || slot === undefined) {
    return null
  }
  // Legacy plain-URL shape (should not appear after migration).
  if (typeof slot === 'string') {
    return slot.length > 0 ? slot : null
  }
  const idx = Math.max(0, Math.min(slot.selectedIdx, slot.versions.length - 1))
  const url = slot.versions[idx]
  if (typeof url !== 'string' || url.length === 0) {
    return null
  }
  return url
}

/**
 * True when this tile has at least one refine result to show / cycle.
 */
export function tileSlotHasResult(
  slot: InpaintTileSlot | string | null | undefined,
): boolean {
  if (slot === null || slot === undefined) {
    return false
  }
  if (typeof slot === 'string') {
    return slot.length > 0
  }
  return slot.versions.some((url) => typeof url === 'string' && url.length > 0)
}

/**
 * How many filled refine versions a slot has (for the 1/N cycler).
 */
export function tileSlotVersionCount(
  slot: InpaintTileSlot | null | undefined,
): number {
  if (!slot) {
    return 0
  }
  return slot.versions.filter((url) => typeof url === 'string' && url.length > 0).length
}

/**
 * One complete post-plan stack: global plan, change mask, and that option's
 * tile results. Generate produces {@link INPAINT_VARIANT_COUNT} of these with
 * the same settings; the sidebar cycler swaps which one is shown.
 */
export interface InpaintVariant {
  /**
   * Scale factor from context-perimeter pixels to global-plan image pixels.
   * Computed by buildGlobalPlanInput (context-pixel → plan-pixel).
   */
  globalPlanScale: number
  /** LLM global plan result URL (low-res, from the 'plan' API call). */
  globalPlanUrl: string | null
  /**
   * B&W visualisation of the client-side pixel diff (white = changed, black =
   * unchanged). Display only — never sent to the API.
   */
  changeMaskUrl: string | null
  /**
   * Global plan composited with a light-blue highlight over changed regions.
   * Display only — never sent to the API.
   */
  changeMaskOverlayUrl: string | null
  /** Per-tile refine slots (four free add-detail versions each) for this plan variant. */
  tileResults: InpaintTileSlot[]
  /**
   * Full-image merge of this variant's running inpaint canvas stamped into
   * the source. Set as soon as the plan composite exists (before tiles);
   * rebuilt whenever a tile is generated or a refine option is cycled.
   */
  stitchedPreviewUrl: string | null
}

/**
 * Empty variant slot used before Generate finishes and when resetting.
 */
export function createEmptyInpaintVariant(): InpaintVariant {
  return {
    globalPlanScale: 1,
    globalPlanUrl: null,
    changeMaskUrl: null,
    changeMaskOverlayUrl: null,
    tileResults: [],
    stitchedPreviewUrl: null,
  }
}

/**
 * Four empty variant slots — the starting set for a new inpaint session.
 */
export function createEmptyInpaintVariants(): InpaintVariant[] {
  return Array.from({ length: INPAINT_VARIANT_COUNT }, () => createEmptyInpaintVariant())
}

/**
 * The variant the sidebar and overlay currently display, or null if the
 * selected index is out of range.
 */
export function selectedInpaintVariant(state: InpaintState): InpaintVariant | null {
  const variant = state.variants[state.selectedVariantIdx]
  if (!variant) {
    return null
  }
  return variant
}

/**
 * Full phase-machine state for an active inpaint session managed by EditStudio.
 * EditPanel receives this as a prop and renders accordingly.
 */
export interface InpaintState {
  phase: InpaintPhase
  region: InpaintRegion
  editPrompt: string
  referenceImages: ReferenceImage[]
  /**
   * Clean low-res context crop (no annotation). Sent as the "before" image to
   * the extract-mask API so the model can identify what changed.
   */
  lowResContextUrl: string | null
  /**
   * Same crop as `lowResContextUrl` but with the selection rectangle drawn on
   * top as a visual aid. Never sent to the API — display only.
   */
  lowResPreviewUrl: string | null
  /**
   * Shared tile-grid geometry for every variant. Null on the fast path
   * (context fits in one tile) and before the first plan finishes.
   */
  tilePlan: InpaintTilePlan | null
  /** Independent plan / mask / tile stacks produced by Generate. */
  variants: InpaintVariant[]
  /** Which variant the sidebar, overlay, and Accept currently show. */
  selectedVariantIdx: number
  /**
   * How many of the parallel plan calls have finished. Used for
   * "Generating global plans 2/4…" while phase is still `planning`.
   */
  planningCompletedCount: number
  /** Index of the tile currently being processed. Null when idle. */
  generatingTileIdx: number | null
  error: string | null
}

/**
 * Common engine-friendly horizontal targets for sidescroller backgrounds.
 * Multiples of common 16:9 game widths so tiling lands on clean boundaries.
 */
