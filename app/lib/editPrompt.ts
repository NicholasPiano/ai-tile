/**
 * Prompt builders for the Edit-tab mask-generation and inpainting workflow.
 *
 * These are pure string-building functions used by both the API routes (server)
 * and optionally the client. Do NOT add 'use client' here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mask generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt for generating a black-and-white mask from a user description.
 *
 * The model receives the context region image (selection + surrounding strip)
 * and should return a pure B&W mask at exactly the same dimensions.
 *
 * WHITE pixels → area matching `description`
 * BLACK pixels → everything else
 */
export function buildMaskPrompt(description: string): string {
  return [
    'You are a precision image mask generator.',
    '',
    'I will give you an image. Return a black-and-white mask image that is the',
    'EXACT same pixel dimensions as the input.',
    '',
    `WHITE pixels (#FFFFFF): the area that matches "${description}"`,
    'BLACK pixels (#000000): everything else',
    '',
    'Rules:',
    '- Return ONLY the mask image — no text, no explanation, no border',
    '- Same pixel width and height as the input image',
    '- Use clean, hard edges at object boundaries (avoid anti-aliased fades)',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Inpainting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt for inpainting when the edit zone is the full selection box.
 *
 * The model receives one image: the context region (strip + selection) with the
 * selection area drawn in a blue rectangle. Only that rectangle may change.
 * The strip border around it is the theme guide and must remain unchanged.
 */
export function buildSelectionInpaintPrompt(editDescription: string): string {
  return [
    'You are an expert inpainting artist.',
    '',
    'You have been given a scene image.',
    'A blue-bordered rectangle marks the EDIT ZONE.',
    'The surrounding area outside that rectangle is the CONTEXT ZONE.',
    '',
    `Edit instruction: ${editDescription}`,
    '',
    'Critical rules:',
    '- Apply the edit ONLY inside the blue rectangle.',
    '- Do NOT alter any pixel outside the blue rectangle — the context zone must',
    '  be pixel-perfect and completely unchanged.',
    '- Study the context zone carefully: match its lighting, colour temperature,',
    '  perspective, texture density, and art style exactly.',
    '- Blend the edited region seamlessly into the surrounding context at every edge.',
    '- Return the COMPLETE image at exactly the same dimensions as the input.',
    '  Do not crop, letterbox, or resize.',
  ].join('\n')
}

/**
 * Prompt for inpainting when a text-generated mask defines the edit zone.
 *
 * The model receives TWO images:
 *   IMAGE 1 — the context region (strip + selection)
 *   IMAGE 2 — a black-and-white mask (WHITE = edit zone, BLACK = do not touch)
 *
 * Only the WHITE area in the mask may change.
 */
export function buildMaskedInpaintPrompt(editDescription: string): string {
  return [
    'You are an expert inpainting artist.',
    '',
    'IMAGE 1: the scene to edit (contains a context ring and an inner edit region)',
    'IMAGE 2: a black-and-white mask',
    '   WHITE = the exact pixels that should be edited',
    '   BLACK = the exact pixels that must not change at all',
    '',
    `Edit instruction: ${editDescription}`,
    '',
    'Critical rules:',
    '- Edit ONLY the WHITE area indicated by the mask.',
    '- The BLACK area must remain completely unchanged — pixel-perfect.',
    '- Study the BLACK (context) area carefully: match its lighting, colour',
    '  temperature, perspective, texture density, and art style exactly.',
    '- Blend the edited region seamlessly into the context at every boundary.',
    '- Return the COMPLETE image at exactly the same dimensions as IMAGE 1.',
    '  Do not crop, letterbox, or resize.',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiled Inpaint Pipeline prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 1 prompt for generating a global low-res inpaint plan.
 *
 * The model receives the low-res context crop where the masked area has been
 * filled with grey (#B0B0B0). It should fill the grey with content that
 * matches the instruction and blends seamlessly with the surrounding context.
 *
 * Optionally a second image (B&W mask) can be prepended by the caller when
 * the user is on the text-mask path, to clarify the exact fill region.
 */
export function buildInpaintPlanPrompt(editDescription: string): string {
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

/**
 * Phase 2 prompt for high-resolution per-tile refinement.
 *
 * The model receives a full-resolution tile where the masked sub-region shows
 * a scaled-up (blurry/low-res) preview of the intended result from Phase 1,
 * with a solid 4-pixel blue border marking its exact boundary.
 * The surrounding pixels are the original high-resolution context.
 *
 * The model must upscale/refine the low-res content inside the blue border
 * into crisp, high-resolution content that matches the edit instruction and
 * blends seamlessly with the context — WITHOUT changing anything outside
 * the blue border.
 */
export function buildInpaintTilePrompt(editDescription: string): string {
  return [
    'You are an expert image inpainting artist doing high-resolution refinement.',
    '',
    'You are given a full-resolution image tile. A blue-bordered rectangle marks',
    'the EDIT ZONE. Inside that rectangle is a low-resolution, blurry preview of',
    'the intended result. The area outside the blue border is the original',
    'high-resolution context — it must not change.',
    '',
    `Edit instruction: ${editDescription}`,
    '',
    'Your task:',
    '1. Look at the low-res content inside the blue border.',
    '2. Re-generate that content in full high resolution, following the edit',
    '   instruction and matching the global style, lighting, and perspective.',
    '3. Return the COMPLETE tile image at exactly the same pixel dimensions.',
    '',
    'Critical rules:',
    '- Modify ONLY the pixels inside the blue rectangle.',
    '- Every pixel outside the blue rectangle must be pixel-perfect unchanged.',
    '- Blend the edited region seamlessly into the context at every edge.',
    '- Do NOT return the blue border itself in the output — fill right to the edge.',
    '- Do not crop, letterbox, or resize the image.',
  ].join('\n')
}
