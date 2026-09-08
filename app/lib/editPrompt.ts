/**
 * Prompt builders for the Edit-tab inpainting workflow.
 *
 * Pure string-building functions — no 'use client' so they can be safely
 * imported by both API routes (server) and client components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — global low-res plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt for generating the global low-resolution inpaint plan.
 *
 * The model receives a context-region image where the selection area has been
 * filled with grey (#B0B0B0) and bordered in red. It should fill the grey zone
 * with content that matches `editDescription` and blends into the context.
 */
export function buildGlobalPlanPrompt(editDescription: string): string {
  return [
    'You are an expert image inpainting artist.',
    '',
    'You are given an image. Inside the image there is a RED-BORDERED rectangle.',
    'The area inside that red border has been filled with a solid grey placeholder',
    '(#B0B0B0). Everything outside the red border is the original image context.',
    '',
    `Edit instruction: ${editDescription}`,
    '',
    'Your task: Fill the grey area inside the red border with content that matches',
    'the instruction, blending seamlessly into the surrounding context.',
    '',
    'STRICT rules — violating any of these is a FAILURE:',
    '- Modify ONLY the pixels inside the red border. Zero exceptions.',
    '- Any pixel outside the red border must be returned pixel-perfect and',
    '  completely unchanged. Editing outside the red border is a FAILURE.',
    '- Do NOT include the red border itself in the output — paint right up to',
    '  the edge and blend naturally.',
    '- Match the surrounding lighting, colour temperature, perspective, texture,',
    '  and art style exactly.',
    '- Return the COMPLETE image at exactly the same pixel dimensions as the input.',
    '  Do not crop, letterbox, or resize.',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — change-mask extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt for extracting a B&W change-mask by comparing the original context
 * crop with the global plan result.
 *
 * The model receives two images:
 *   IMAGE 1 — original source context crop (before any edits)
 *   IMAGE 2 — global plan result (after edits)
 *
 * Returns a B&W mask at the same dimensions:
 *   WHITE (#FFFFFF) — pixels that changed
 *   BLACK (#000000) — pixels that are unchanged
 */
export function buildMaskExtractionPrompt(): string {
  return [
    'You are a precision image change-detection tool.',
    '',
    'You have been given two images of the same scene:',
    '  IMAGE 1 — the ORIGINAL image (before any edits)',
    '  IMAGE 2 — the EDITED image (after changes have been made)',
    '',
    'Return a black-and-white mask image at the EXACT same pixel dimensions',
    'as the input images.',
    '',
    'WHITE pixels (#FFFFFF): pixels that have visibly changed between the two images',
    'BLACK pixels (#000000): pixels that are unchanged',
    '',
    'Rules:',
    '- Return ONLY the mask image — no text, no explanation, no border',
    '- Match the exact pixel dimensions of the input images',
    '- Use clean edges at change boundaries',
    '- Add a small margin around changed regions to ensure natural blending',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — per-tile free add-detail refinement
// ─────────────────────────────────────────────────────────────────────────────

/** Position of one tile within the larger inpaint tile grid. */
export interface TilePositionContext {
  /** 1-indexed position of this tile among all tiles in the grid. */
  index: number
  /** Total number of tiles in the grid. */
  total: number
}

/**
 * Prompt for per-tile free add-detail refinement.
 *
 * The model receives a single image: the approved global plan, upscaled
 * into the selection with no extra blur, and crisp original (or already
 * refined neighbour) pixels outside that selection. The plan is inspiration
 * only — the hard lock is the crisp ring. Invent native-resolution detail
 * and features a finished image would have here.
 */
export function buildTileRefinementPrompt(
  editDescription: string,
  tilePosition?: TilePositionContext,
): string {
  const trimmed = editDescription.trim()
  const lines = [
    'You are an expert photo detail-enhancement artist performing a FREE ADD-DETAIL pass.',
    '',
    'You have been given an image. Part of it is a LOWER-RESOLUTION COMPOSITION PLAN',
    '(upscaled in place) — treat it as INSPIRATION only: a suggested layout and subject',
    'matter, NOT a photograph to trace and NOT a composition lock. Everything else is',
    'CRISP original or already-refined pixels — leave those pixels exactly unchanged.',
    '',
    'YOUR JOB: redraw the planned area at full native resolution as a richly detailed,',
    'finished patch that could have been part of the original image. You MAY change',
    'objects, add features the plan never showed, and take a different compositional',
    'read if that produces a richer result. Do NOT reproduce the plan\'s soft,',
    'posterized, or blob-like forms as sharper versions of themselves — that is a FAILURE.',
    '',
    'TASK:',
    '1. Find the planned (lower-resolution) area.',
    '2. Paint it at full native detail, inventing the texture, materials, edges, and',
    '   features a finished image would have here, inspired by (not copying) the plan.',
    '3. Leave every crisp pixel outside that area unchanged.',
    '',
    'The crisp pixels define the rendering style — match their texture, lighting,',
    'colour, perspective, scale, and level of detail exactly at the seam. The boundary',
    'must be invisible.',
    '',
    'Do NOT copy or shift content from the crisp area into the planned area.',
  ]

  if (trimmed.length > 0) {
    lines.push(
      '',
      `USER DIRECTION for what to enrich in this area: "${trimmed}".`,
      'Apply this as creative direction for the detail pass. This tile may show only a',
      'tiny fragment of a larger edit (e.g. plain sky, a patch of texture, or empty',
      'background) — if so, enrich that fragment; do not force the full instruction',
      'into this one tile.',
    )
  } else {
    lines.push(
      '',
      'No extra user direction — simply add native-resolution detail inspired by the plan.',
    )
  }

  if (tilePosition && tilePosition.total > 1) {
    lines.push(
      '',
      `TILE CONTEXT: This is tile ${tilePosition.index} of ${tilePosition.total} in a larger edit`,
      'region. Crisp pixels near an edge may already show sharpened content from a',
      'neighbouring tile processed just before this one — continue it seamlessly.',
      'Do NOT repeat, mirror, or duplicate content from neighbouring tiles.',
    )
  }

  lines.push('', 'Return the image at exactly the same pixel dimensions.')

  return lines.join('\n')
}
