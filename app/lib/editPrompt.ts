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
// Stage 3 — per-tile high-resolution refinement
// ─────────────────────────────────────────────────────────────────────────────

/** Position of one tile within the larger inpaint tile grid. */
export interface TilePositionContext {
  /** 1-indexed position of this tile among all tiles in the grid. */
  index: number
  /** Total number of tiles in the grid. */
  total: number
}

/**
 * Prompt for per-tile high-resolution refinement.
 *
 * The model receives a single image where the edit zone contains blurry pixels
 * (softened, upscaled plan content) and everything outside is crisp — either
 * original source or, at shared edges, already-sharpened neighbouring tiles.
 * The blurry / crisp contrast is the sole zone marker — no border annotation.
 *
 * This is a super-resolution / detail pass, NOT a second inpaint. The global
 * plan already decided composition and content; this stage's only job is to
 * render the blurry preview at full resolution, matching the crisp
 * surroundings. The original edit description is included purely as loose
 * context — a tile is often a small, cropped fragment of the full selection
 * (sometimes an almost-featureless sliver of it) and must NOT be redrawn as
 * if it had to depict the whole instruction on its own.
 */
export function buildTileRefinementPrompt(
  editDescription: string,
  tilePosition?: TilePositionContext,
): string {
  const lines = [
    'You are an expert photo detail-enhancement tool performing a super-resolution pass.',
    '',
    'You have been given an image. Part of it is BLURRY — a low-resolution preview',
    'of already-decided content. Everything else is CRISP — leave those pixels',
    'exactly unchanged.',
    '',
    'YOUR ONLY JOB: sharpen the blurry area into full-resolution detail that matches',
    'what it is already previewing. This is NOT a request to invent new content —',
    'the composition, shapes, and colours in the blurry area are already correct;',
    'you are only adding resolution and texture.',
    '',
    'TASK:',
    '1. Find the blurry area.',
    '2. Redraw it at full resolution as a faithful, detailed version of that exact',
    '   blurry content — same shapes, same colours, same layout — now sharp and',
    '   richly detailed, blending seamlessly with the crisp surroundings.',
    '3. Leave every crisp pixel unchanged.',
    '',
    'The crisp pixels define the rendering style — match their texture, lighting,',
    'colour, and level of detail exactly in the redrawn area.',
    '',
    'Do NOT copy or shift content from the crisp area into the blurry area.',
    'Do NOT add objects, shapes, or scene elements that are not already implied by',
    'the blurry preview, even if they would fit the description below.',
    '',
    `For loose context only, this tile is a small crop from a larger edit whose`,
    `overall goal was: "${editDescription}". This tile may show only a tiny,`,
    'unremarkable fragment of that larger edit (e.g. plain sky, a patch of texture,',
    'or empty background) — if so, that is correct and expected. Use the',
    'description only to resolve genuine ambiguity in the blurry pixels; never as',
    'a reason to depict the full instruction within this one tile.',
  ]

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
