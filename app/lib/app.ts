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
 * Minimum strip of original image pixels that must remain visible around any
 * edit selection. This context border is sent to the inpaint model so it can
 * match the surrounding scene.
 */
export const EDIT_STRIP_PX = 256

/**
 * Maximum width or height of the inpaint selection in image pixels.
 *
 * The region actually sent to the model is `selection + EDIT_STRIP_PX` on
 * every side, so its total dimension is `selection + 2 × EDIT_STRIP_PX`.
 * That total must stay within `MAX_AI_DIMENSION` (1536 px), giving:
 *
 *   MAX_EDIT_SELECTION_PX = MAX_AI_DIMENSION − 2 × EDIT_STRIP_PX
 *
 * The selection guide drawn on the canvas is therefore dynamic: it reflects
 * the largest box reachable from the drag-start point within both this limit
 * and the image edge constraints.
 */
export const MAX_EDIT_SELECTION_PX = MAX_AI_DIMENSION - 2 * EDIT_STRIP_PX

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

/** Whether the edit mask is defined by the drawn rectangle or by an AI-generated B&W image. */
export type InpaintMaskType = 'rect' | 'image'

/**
 * User-defined region for inpainting — the drawn selection, its derived context
 * perimeter, and the mask that restricts which pixels may change.
 */
export interface InpaintRegion {
  /** Selection drawn by the user, in image-pixel coordinates. */
  selectionRect: { x: number; y: number; w: number; h: number }
  /** Which kind of mask governs the edit zone. */
  maskType: InpaintMaskType
  /** B&W mask URL from /api/edit-mask (text-mask path only). Undefined for 'rect'. */
  maskImageUrl?: string
  /** Context perimeter bounding rect in image-pixel coordinates. */
  contextRect: { x: number; y: number; w: number; h: number }
}

/** Phases of the tiled inpaint workflow managed by EditStudio. */
export type InpaintPhase =
  | 'mask'      // Stage 1: choose mask type / describe what to mask
  | 'prompt'    // Stage 2: enter edit description + optional reference images
  | 'planning'  // Phase 1 running: low-res global plan
  | 'tiling'    // Phase 2 running: per-tile high-res refinement
  | 'done'      // All tiles complete; awaiting Accept / Discard

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
   * The intersection of the edit mask with this tile in tile-local coordinates.
   * Null when the tile is pure context — the API call should be skipped.
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
   * Low-res context crop built from the source image.
   * Shared input for mask generation (step 3) and the global plan (step 5).
   * Kept clean (no annotation) so it can be sent directly to the API.
   */
  lowResContextUrl: string | null
  /**
   * Same crop as `lowResContextUrl` but with the selection rectangle drawn
   * on top as a visual aid — used only for display in the panel preview.
   * Never changes after the selection is committed.
   */
  lowResPreviewUrl: string | null
  /**
   * Context crop composited with the AI-generated mask as a blue highlight.
   * Set after /api/edit-mask returns. Shown as a second preview below the
   * original selection preview in the locked mask section.
   */
  maskOverlayUrl: string | null
  /** Scale factor from context-perimeter pixels to low-res-crop pixels. */
  lowResScale: number
  /** Phase 1 global plan result URL (low-res). */
  globalPlanUrl: string | null
  tilePlan: InpaintTilePlan | null
  /** Per-tile AI result URLs (null = not yet generated). */
  tileResults: Array<string | null>
  /** Index of the tile currently being processed. Null when idle. */
  generatingTileIdx: number | null
  /** True while the mask is being generated (within 'mask' phase). */
  maskGenerating: boolean
  error: string | null
  /**
   * Debug: the data URL of the last tile's INPUT image (what was sent to the model).
   * Only populated when DEBUG_PAINT_TEST is false; shown in the panel for diagnosis.
   */
  tileDebugInputUrl: string | null
  /**
   * Debug: the data URL of the last tile's RESULT image (what the model returned).
   * Only populated when DEBUG_PAINT_TEST is false; shown alongside the input.
   */
  tileDebugResultUrl: string | null
}

/**
 * Common engine-friendly horizontal targets for sidescroller backgrounds.
 * Multiples of common 16:9 game widths so tiling lands on clean boundaries.
 */
