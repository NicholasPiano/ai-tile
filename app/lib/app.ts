'use client'

export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * One generated extension result. For horizontal extensions we produce up to
 * `maxAttempts` candidates, sort them by seam quality (lowest residual first),
 * and let the user cycle through them before accepting. Vertical extensions
 * produce a single candidate (the chunked path is deterministic enough that
 * multiple tries rarely help).
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
 * against accidental runaway cost on very large images.
 */
export const MAX_TILES_PER_EXTEND = 24

/**
 * Longest edge of the global/per-tile planning map sent to Phase 1/2.
 * Higher values preserve more detail in the plan but cost more tokens.
 */
export const PLANNING_MAP_MAX_DIM = 1024

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

export const STORAGE_MODE = 'extender:mode'

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
  | 'masking'   // change-mask extraction LLM call in progress
  | 'tiling'    // per-tile high-res refinement in progress
  | 'done'      // all tiles complete; awaiting Accept / Discard

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
   * Scale factor from context-perimeter pixels to global-plan image pixels.
   * Computed by buildGlobalPlanInput and used when constructing per-tile inputs.
   */
  globalPlanScale: number
  /** LLM global plan result URL (low-res, from the 'plan' API call). */
  globalPlanUrl: string | null
  /**
   * B&W change-mask extracted by the 'extract-mask' API call.
   * WHITE pixels = changed by the global plan; BLACK pixels = unchanged.
   */
  globalMaskUrl: string | null
  /**
   * Global plan composited with the change-mask as a blue highlight — display
   * only, never sent to the API.
   */
  globalMaskOverlayUrl: string | null
  tilePlan: InpaintTilePlan | null
  /** Per-tile AI result URLs (null = not yet generated). */
  tileResults: Array<string | null>
  /** Index of the tile currently being processed. Null when idle. */
  generatingTileIdx: number | null
  error: string | null
}

/**
 * Common engine-friendly horizontal targets for sidescroller backgrounds.
 * Multiples of common 16:9 game widths so tiling lands on clean boundaries.
 */
