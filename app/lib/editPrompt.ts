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
 * The model receives a full-resolution tile where:
 *   - A BLUE-BORDERED rectangle marks the edit zone.
 *   - Inside the blue border: a SOFTENED COMPOSITION PLAN — a low-resolution,
 *     blurry preview showing correct layout and colour, but not the target look.
 *   - Outside the blue border: original high-resolution context (style reference).
 *
 * Mirrors the structure of the extension hasBakedPlanning tile prompt:
 *   - Named PIXEL LAYOUT regions.
 *   - Numbered task steps.
 *   - STYLE AUTHORITY: context = how to render; plan = what to show.
 *   - FORBIDDEN OUTPUTS list.
 *   - "IGNORE its pixel structure" framing so the model does not clone-stamp.
 */
export function buildTileRefinementPrompt(editDescription: string): string {
  return [
    'You are an expert image renderer. You have been given a full-resolution image',
    'tile where a BLUE-BORDERED rectangle marks an EDIT ZONE that contains a',
    'SOFTENED COMPOSITION PLAN — layout and colour guidance only, NOT the target look.',
    '',
    'PIXEL LAYOUT OF THE TILE:',
    '- OUTSIDE the blue border → HIGH-RESOLUTION original scene content.',
    '  This is your STYLE REFERENCE. Preserve these pixels EXACTLY —',
    '  pixel-perfect, no changes whatsoever.',
    '- INSIDE the blue border → SOFTENED composition plan (may look blurry or',
    '  blocky). IGNORE its pixel structure. Your job is to render this area as a',
    '  sharp, full-resolution version of what the plan depicts.',
    '',
    `Edit instruction (what the plan depicts): ${editDescription}`,
    '',
    'YOUR TASK:',
    '1. Preserve EVERY pixel outside the blue border exactly as-is — do not alter',
    '   them in any way.',
    '2. Study the pixels outside the blue border for rendering style: texture',
    '   density, edge sharpness, colour depth, shading model, and level of realism.',
    '   The edit zone MUST match this exactly.',
    '3. Render the area inside the blue border using the plan ONLY for composition',
    '   (where things go, general shapes, colour masses):',
    '   - Same subjects, spatial layout, and proportions as the plan shows.',
    '   - Full native-resolution detail, texture, and anti-aliasing matching the',
    '     surrounding context.',
    '   - Do NOT copy the plan\'s blur, blockiness, flat colours, or simplified',
    '     rendering — those are artefacts of the low-res preview, not the goal.',
    '   - Do NOT copy, clone, or shift content from outside the border into the',
    '     zone. Every element inside the border must sit at the position the plan',
    '     places it — no offset, no mirror, no paste of nearby context.',
    '4. Make the boundary between the edit zone and the surrounding context',
    '   completely invisible — no seam, colour shift, or brightness jump.',
    '   Any object or surface crossing the blue border must line up seamlessly.',
    '',
    'STYLE AUTHORITY (critical):',
    '- The high-resolution pixels outside the blue border are the SOLE authority',
    '  for how the edit zone should look.',
    '- The plan defines WHAT to show, not HOW to render it.',
    '- Output must look like the same photograph, render, or artwork with the',
    '  edit applied at full quality — as if captured at the same resolution as',
    '  the surrounding context.',
    '',
    'FORBIDDEN OUTPUTS (unless the surrounding context already uses that exact style):',
    '- Cartoon, anime, chibi, or illustration-simplified rendering',
    '- Pixel art, 8-bit, 16-bit, or retro-game aesthetics',
    '- Flat shading, posterization, banding, or limited colour palettes',
    '- Visible upscaled blocks, chunky pixels, or mosaic artefacts',
    '- Clip-art, vector-icon, or children\'s-book simplification',
    '',
    'A result that looks like an upscaled, cartoonified, or pixelated version of',
    'the plan — or that pastes a shifted copy of the surrounding context into the',
    'zone — is a FAILURE.',
    '',
    'OUTPUT RULES:',
    '- Do NOT draw or recreate the blue border itself.',
    '- Return the COMPLETE tile at exactly the same pixel dimensions — do not crop,',
    '  letterbox, pad, or resize.',
  ].join('\n')
}
