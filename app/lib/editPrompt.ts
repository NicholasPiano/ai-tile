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

/**
 * Prompt for per-tile high-resolution refinement.
 *
 * The model receives a single image where the edit zone contains blurry pixels
 * (4× downsampled plan) and everything outside is crisp source. The blurry /
 * crisp contrast is the sole zone marker — no border annotation.
 */
export function buildTileRefinementPrompt(editDescription: string): string {
  return [
    'You are an expert image editor.',
    '',
    'You have been given an image. Part of it is BLURRY — this is the area you',
    'need to work on. Everything else is CRISP — leave those pixels exactly unchanged.',
    '',
    `Edit instruction: ${editDescription}`,
    '',
    'TASK:',
    '1. Find the blurry area.',
    '2. Redraw it at full resolution so it matches the edit instruction, blends',
    '   seamlessly with the crisp surroundings, and looks like it was always',
    '   part of the same image.',
    '3. Leave every crisp pixel unchanged.',
    '',
    'The crisp pixels define the rendering style — match their texture, lighting,',
    'colour, and level of detail exactly in the redrawn area.',
    '',
    'Do NOT copy or shift content from the crisp area into the blurry area.',
    'Return the image at exactly the same pixel dimensions.',
  ].join('\n')
}
