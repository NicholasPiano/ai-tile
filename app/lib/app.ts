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


export type Mode = 'extender' | 'parallax' | 'tile' | 'sprite' | 'props'

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

/**
 * Common engine-friendly horizontal targets for sidescroller backgrounds.
 * Multiples of common 16:9 game widths so tiling lands on clean boundaries.
 */
