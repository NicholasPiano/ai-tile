/**
 * Shared prompt builder for image extension.
 *
 * Extracted from the /api/extend route so both the server route and the
 * client-side TileExtensionModal can produce the exact same text that is
 * sent to the model.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Subset of ChunkInfo fields consumed by the prompt builder. */
export interface PromptChunkInfo {
  direction: 'up' | 'down' | 'left' | 'right'
  originalWidth: number
  originalHeight: number
  chunkWidth: number
  chunkHeight: number
  extensionSize: number
  tileIndex?: number
  tileCount?: number
}

/** Dimensions of the full-context extension result. */
export interface PromptExtensionInfo {
  newWidth: number
  newHeight: number
}

export interface BuildExtendPromptParams {
  direction: 'up' | 'down' | 'left' | 'right'
  chunkInfo?: PromptChunkInfo | null
  useFullContext?: boolean
  extensionInfo?: PromptExtensionInfo | null
  customPrompt?: string | null
  artStyle?: string | null
  layerRole?: string | null
  sceneBrief?: string | null
  attempt?: number
  /**
   * Descriptions for user-supplied reference images. When provided, the
   * prompt switches to multi-image mode and labels them so the model
   * understands their role relative to the tile strip (IMAGE 1).
   */
  referenceImages?: { description: string }[]
  /**
   * When set, a phase-1 planning result is attached as an extra image.  The
   * prompt inserts a block that identifies this image and explains its role
   * as a low-res composition guide — not a pixel source.
   *
   * The label index accounts for IMAGE 1 (tile strip) already being taken;
   * the caller is responsible for injecting the planning result image at the
   * correct position in the API message.
   */
  hasPlanningGuide?: boolean
}

export interface BuildPlanningPromptParams {
  direction: 'up' | 'down' | 'left' | 'right'
  tileIndex: number
  tileCount: number
  customPrompt?: string | null
  artStyle?: string | null
  sceneBrief?: string | null
  referenceImages?: { description: string }[]
}

// ── Art style labels ─────────────────────────────────────────────────────────

export const ART_STYLE_DESCRIPTIONS: Record<string, string> = {
  'cinematic': 'cinematic photography with dramatic lighting and film grain',
  'vintage': 'vintage film photography with faded colors and retro feel',
  'black-white': 'black and white photography with rich contrast',
  'macro': 'macro photography with shallow depth of field',
  'oil-painting': 'oil painting style with visible brush strokes and rich textures',
  'watercolor': 'watercolor painting with soft washes and flowing colors',
  'impressionism': 'impressionist painting style with loose brushwork',
  'abstract': 'abstract art with bold shapes and colors',
  'pop-art': 'pop art style with bold colors and graphic elements',
  'cubism': 'cubist style with geometric shapes and multiple perspectives',
  'minimalist': 'minimalist art with simple forms and limited colors',
  'digital-art': 'digital art with smooth gradients and modern aesthetics',
  'cyberpunk': 'cyberpunk style with neon colors and futuristic elements',
  'vaporwave': 'vaporwave aesthetic with pastel colors and retro-futuristic vibes',
  'low-poly': 'low poly 3D art with geometric faceted surfaces',
  'pixel-art': 'pixel art style with retro video game aesthetics',
  '3d-render': '3D rendered look with realistic lighting and materials',
  'anime': 'anime/manga style with bold lines and vibrant colors',
  'cartoon': 'cartoon illustration with exaggerated features',
  'comic-book': 'comic book style with bold inking and halftone dots',
  'sketch': 'pencil sketch with cross-hatching and shading',
  'ink': 'ink drawing with bold black lines and dramatic contrast',
  'studio-ghibli': 'Studio Ghibli animation style with whimsical, hand-drawn aesthetics and rich environmental details',
  'pixar': 'Pixar animation style with smooth 3D rendering, expressive characters, and vibrant colors',
  'disney': 'Disney animation style with classic hand-drawn or modern 3D aesthetics and magical atmosphere',
  'dreamworks': 'DreamWorks animation style with dynamic expressions and cinematic lighting',
  'illumination': 'Illumination Entertainment style with bright colors, playful characters, and bold shapes',
  'laika': 'Laika Studios stop-motion style with intricate textures and handcrafted details',
  'cartoon-network': 'Cartoon Network style with bold outlines, simplified shapes, and vibrant colors',
  'nickelodeon': 'Nickelodeon animation style with energetic, expressive characters and bright color palettes',
  'aardman': 'Aardman claymation style with textured plasticine characters and British humor aesthetics',
  'blue-sky': 'Blue Sky Studios animation style with detailed 3D rendering and dynamic action sequences',
  'fantasy': 'fantasy art with magical and ethereal elements',
  'sci-fi': 'science fiction with futuristic technology and environments',
  'steampunk': 'steampunk style with Victorian-era and industrial elements',
  'surreal': 'surrealist style with dreamlike and impossible elements',
  'art-deco': 'Art Deco style with geometric patterns and elegant lines',
  'art-nouveau': 'Art Nouveau with flowing organic lines and natural motifs',
  'retro-80s': '1980s retro style with bright colors and bold graphics',
  'retro-50s': '1950s vintage style with pastel colors and classic aesthetics',
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Assemble the text prompt sent to the model for a single extension call.
 *
 * This is the canonical source of truth for prompt text; the /api/extend
 * route and the client-side TileExtensionModal both call this function so
 * they always produce identical strings.
 *
 * Prompt mode matrix:
 *   No refs, no custom prompt  →  single-image, pure continuation, "do NOT introduce new subjects"
 *   No refs, custom prompt     →  single-image, SCENE CONTINUITY + USER DIRECTION, "do NOT introduce new subjects"
 *   With user refs             →  multi-image preamble, IMAGE 1 is working canvas, refs guide new allowed content
 */
export function buildExtendPrompt(params: BuildExtendPromptParams): string {
  const {
    direction,
    chunkInfo,
    useFullContext,
    extensionInfo,
    customPrompt,
    artStyle,
    layerRole,
    sceneBrief,
    attempt = 0,
    referenceImages,
    hasPlanningGuide,
  } = params

  const directionDescriptions: Record<string, string> = {
    up: 'top',
    down: 'bottom',
    left: 'left side',
    right: 'right side',
  }
  const dirDesc = directionDescriptions[direction]

  const isFullContext = !!useFullContext
  const isChunked = !isFullContext && !!chunkInfo

  // Multi-image mode activates when the user has supplied reference images OR
  // a planning guide is present (both add extra images after the tile strip).
  const hasRefs = !!(referenceImages && referenceImages.length > 0)
  const hasExtras = hasRefs || !!hasPlanningGuide

  // Planning guide is IMAGE 2 when present; user refs follow after it.
  const refImageOffset = hasPlanningGuide ? 2 : 1

  const multiImagePreamble = hasExtras
    ? `MULTI-IMAGE REQUEST — IMAGE ROLES:
- IMAGE 1: your WORKING CANVAS — the tile strip you must modify and return. This is the only image that determines your output dimensions and content.
- IMAGE 2, 3, …: REFERENCE ONLY — style or content guides supplied by the user. Do NOT return them. Do NOT paste, resize, composite, or substitute them for your output.

`
    : ''

  // Wording switches between single-image and multi-image requests.
  const workingImage = hasExtras ? 'IMAGE 1' : 'this image'
  const layoutLabel = hasExtras ? 'IMAGE 1' : 'THIS IMAGE'
  const outputImage = hasExtras ? 'IMAGE 1 with the gray area filled' : 'the complete image with the blank area filled'

  let prompt: string

  if (isFullContext) {
    prompt = `${multiImagePreamble}OUTPAINTING TASK: You are extending ${workingImage} ${direction === 'left' || direction === 'right' ? 'HORIZONTALLY' : 'VERTICALLY'} on the ${dirDesc}.

${hasExtras ? 'IMAGE 1 has' : 'The input is a single image. The'} ${dirDesc} portion of the canvas is filled with solid LIGHT GRAY (#B0B0B0). This gray area is the empty space you must fill with realistic scene content.

YOUR TASK:
1. Generate a complete output image at the SAME pixel dimensions as ${workingImage}.
2. Replace EVERY gray pixel with photorealistic content that continues the existing scene naturally.
3. Keep the non-gray (already-painted) pixels exactly as they appear${hasExtras ? ' in IMAGE 1' : ' in the input'}.

EXTENSION RULES:
- The blank area is on the ${dirDesc} side (${direction === 'up' ? 'ABOVE' : direction === 'down' ? 'BELOW' : direction === 'left' ? 'LEFT OF' : 'RIGHT OF'} the existing content).
- ${direction === 'left' || direction === 'right' ? 'For HORIZONTAL extension: continue the same horizon line, sky band, and ground level. Do NOT add a second ground plane, second sky, or new vanishing point. The new area is more of the same lateral landscape at the same elevation.' : 'For VERTICAL extension: continue the same spatial layer (sky above sky, ground below ground). Do not duplicate ground or sky surfaces.'}
- Match exact color temperature, lighting direction, saturation, contrast, and art style of the existing pixels.
- The seam between original and new content must be invisible — no color shift, brightness jump, or texture discontinuity.

CRITICAL: If you return ${workingImage} unchanged with the gray area still present, the task has failed. Every gray pixel MUST be replaced.`
  } else if (isChunked && chunkInfo) {
    const isHorizDir = direction === 'left' || direction === 'right'
    const contextPx = isHorizDir ? chunkInfo.chunkWidth : chunkInfo.chunkHeight
    const extPx = chunkInfo.extensionSize

    const contextSide =
      direction === 'down' ? 'top'
      : direction === 'up' ? 'bottom'
      : direction === 'right' ? 'left'
      : 'right'

    const movingDir =
      direction === 'down' ? 'downward (further below the current view)'
      : direction === 'up' ? 'upward (further above the current view)'
      : direction === 'right' ? 'to the right (further right of the current view)'
      : 'to the left (further left of the current view)'

    prompt = `${multiImagePreamble}You are an expert at seamlessly extending images. You have been given a ${isHorizDir ? 'vertical' : 'horizontal'} strip${hasExtras ? ' (IMAGE 1)' : ''} of an image to extend.

PIXEL LAYOUT OF ${layoutLabel}:
- ${contextSide.toUpperCase()} ${contextPx}px → EXISTING scene content. You must preserve these pixels EXACTLY unchanged.
- ${dirDesc.toUpperCase()} ${extPx}px → Solid light gray (#B0B0B0). This is the ONLY area you must fill.

YOUR TASK:
1. Replace every gray pixel in the ${dirDesc} ${extPx}px area with new scene content.
2. The new content must show what would appear ${movingDir} — it is NEW territory beyond the current frame.
3. Match the perspective, lighting, color palette, and art style of the existing content exactly.
4. Make the transition between existing and new content completely invisible — no seam, color shift, or brightness jump.
5. Keep every pixel in the existing ${contextPx}px area pixel-perfect and unchanged.`
  } else {
    prompt = `${multiImagePreamble}You are an expert at seamlessly extending images. ${hasExtras ? 'IMAGE 1 has' : 'This image has'} a light gray blank area on the ${dirDesc} that needs to be filled naturally.

KEY INSTRUCTIONS:
1. Analyze the existing content carefully - note colors, patterns, textures, lighting
2. Fill the blank ${dirDesc} area by naturally continuing what exists
3. Ensure perfect color matching at the transition boundary
4. Continue any patterns, textures, or elements seamlessly across the border
5. Make the transition completely invisible - no visible seams or borders
6. Preserve the exact style, quality, and atmosphere of the existing content`
  }

  // Art style block
  if (artStyle && ART_STYLE_DESCRIPTIONS[artStyle]) {
    prompt += `\n\n7. ARTISTIC STYLE: Create the extended area in ${ART_STYLE_DESCRIPTIONS[artStyle]}`
    prompt += `\n   - Apply this style consistently to the new content`
    prompt += `\n   - Ensure smooth transition from original to styled extension`
    prompt += `\n   - The style should blend naturally with the existing content at the boundary`
  }

  // Continuity constraints are always present, anchoring the extension to the
  // strip regardless of whether the user added a custom prompt.
  const continuityNumber = artStyle ? '8' : '6'
  prompt += `\n\n${continuityNumber}. SCENE CONTINUITY (always required):`
  prompt += `\n   - Stay strictly within the genre, setting, environment, and subject matter of the existing image`
  // When user reference images are present the model is expected to draw from
  // them for new subjects; suppress the "no new subjects" rule in that case.
  if (!hasRefs) {
    prompt += `\n   - Do NOT introduce new subjects, objects, creatures, or thematic elements that are not already implied by the scene`
  }
  prompt += `\n   - Continue the existing physics consistently: same lighting direction, same time of day, same weather, same atmosphere, same scale, same perspective`
  prompt += `\n   - Avoid mechanical repetition — small natural variation in textures and shapes is good (e.g., slightly different cloud forms, organic terrain undulation, varied foliage)`
  prompt += `\n   - The new area should look like more of the same environment a real camera would capture if panned/tilted in that direction — nothing more, nothing less`
  prompt += `\n   - Match exact color, brightness, contrast, and saturation at the boundary`

  // Custom prompt is an additional directive, not a replacement for continuity.
  if (customPrompt) {
    const requestNumber = artStyle ? '9' : '7'
    prompt += `\n\n${requestNumber}. USER DIRECTION — apply this within the continuity rules above: "${customPrompt}"`
    if (isChunked) {
      prompt += `\n   IMPORTANT - PARTIAL STRIP CONTEXT:`
      prompt += `\n   - You only see an edge strip, not the full image — extrapolate naturally from visible content`
      prompt += `\n   - The user's request applies ONLY to the new ${direction === 'up' ? 'upper' : direction === 'down' ? 'lower' : direction === 'left' ? 'left' : 'right'} area (the light gray blank space)`
      prompt += `\n   - Blend and integrate smoothly with the visible edge content`
      if (!artStyle) {
        prompt += `\n   - Maintain perfect style, color, and lighting consistency`
      }
    } else if (isFullContext) {
      prompt += `\n   IMPORTANT - FULL SCENE CONTEXT:`
      prompt += `\n   - You can see the entire scene — use it to place elements correctly`
      prompt += `\n   - The user's request applies ONLY to the new ${direction === 'up' ? 'upper' : direction === 'down' ? 'lower' : direction === 'left' ? 'left' : 'right'} area (the light gray blank space)`
      prompt += `\n   - Blend and integrate smoothly with the existing scene`
    } else {
      prompt += `\n   - Incorporate this request while maintaining seamless blending`
    }
  }

  // Parallax layer instructions
  const KEY_COLOR_HEX = '#FF00FF'
  if (typeof layerRole === 'string') {
    if (layerRole === 'sky') {
      prompt += `\n\nPARALLAX LAYER — SKY / BACK (must tile horizontally):
- This image is the back-most opaque layer of a parallax scene. The new area must continue the same sky / atmosphere / very-distant horizon only — do NOT introduce mid-ground or foreground elements. Keep the result fully opaque, no transparency, no magenta.
- HORIZONTALLY UNIFORM TONE is required for tileability:
  • The sky tone (color, brightness, saturation) must be IDENTICAL at every X position, including the new area you fill — no left-to-right gradient, no warm-to-cool drift, no one-side-darker-than-the-other.
  • Any gradient must run TOP-TO-BOTTOM ONLY. If the existing image already has a top-to-bottom gradient, copy that exact gradient column-for-column into the new area; every horizontal row at the same Y must end up the same color across the whole result.
  • Do NOT introduce a sun, moon, sunbeams, sunrise/sunset glow, gradient backlighting, vignettes, or any directional light source. If the existing image contains any such directional lighting, blend it OUT in the new area so the result becomes horizontally uniform.
  • Cloud distribution should be roughly even across X — do not concentrate clouds on one side of the new area.`
    } else if (layerRole === 'far' || layerRole === 'mid' || layerRole === 'near') {
      const roleDesc =
        layerRole === 'far'
          ? 'far-distant silhouettes only (distant mountains, faint horizon line)'
          : layerRole === 'mid'
          ? 'mid-distance scene elements only (mid-size trees, buildings, terrain features)'
          : 'near foreground elements only (near grass, foreground bushes, rocks, near tree trunks)'
      prompt += `\n\nPARALLAX LAYER — ${layerRole.toUpperCase()} (alpha-keyed):
- This image is a parallax layer where everything OUTSIDE the actual scene elements is a perfectly flat solid pure magenta color exactly ${KEY_COLOR_HEX} (R=255, G=0, B=255). That magenta will be removed by the client and replaced with transparency.
- In the new area you fill, render ONLY ${roleDesc}. Everywhere else in the new area MUST also be the same flat solid ${KEY_COLOR_HEX} magenta — no other background colors, no sky, no other layers' content.
- Continue the existing elements naturally into the new area. Element silhouettes should be crisp against the magenta to minimize halos.
- Do NOT change the magenta background color in any region — it must stay pure ${KEY_COLOR_HEX} everywhere outside the elements, both in the existing area and in the new area.`
    }
  }

  if (typeof sceneBrief === 'string' && sceneBrief.trim()) {
    prompt += `\n\nSHARED SCENE DIRECTION — maintain this art direction exactly in the new area (palette, lighting, mood, style). Do not drift from it:\n${sceneBrief.trim()}`
  }

  // Reference images block — only present when user has supplied refs.
  // IMAGE 1 is always the tile strip; planning guide (if present) takes IMAGE 2;
  // user refs start at IMAGE (refImageOffset + 1).
  if (hasRefs && referenceImages) {
    const refLines = referenceImages.map((ref, i) => {
      const label = `IMAGE ${refImageOffset + 1 + i}`
      const note = ref.description.trim() ? ref.description.trim() : 'general style or scene reference'
      return `- ${label}: ${note}`
    })
    prompt += `\n\nREFERENCE IMAGES: In addition to IMAGE 1 (the tile strip), you have been provided ${referenceImages.length} user reference image${referenceImages.length === 1 ? '' : 's'}:\n${refLines.join('\n')}\nUse these to inform the style, mood, and content of the new area. The non-gray pixels in IMAGE 1 remain your primary guide for continuity — blend any reference-inspired content seamlessly with what is already visible in IMAGE 1.`
  }

  // Planning guide block — emitted after user refs so numbering is clean.
  if (hasPlanningGuide) {
    const guideLabel = `IMAGE 2`
    prompt += `\n\nCOMPOSITION GUIDE (${guideLabel}): A low-resolution planning image was generated in a prior pass. It shows a suggested composition for the grey area of IMAGE 1. Use it as a layout and mood reference only — do NOT copy its pixels. Your output must match the full-resolution colour, texture, and edge continuity of IMAGE 1's existing pixels. Do NOT use the dimensions of ${guideLabel} for your output.`
  }

  prompt += `\n\nFINAL OUTPUT: Return ${outputImage}. The result must look like a single, unified ${artStyle && ART_STYLE_DESCRIPTIONS[artStyle] ? 'artistic work' : 'scene'} with absolutely no visible seams. The boundary should be completely invisible.`

  if (extensionInfo?.newWidth && extensionInfo?.newHeight) {
    prompt += `\n\nOUTPUT DIMENSIONS: Return ${outputImage} at exactly ${extensionInfo.newWidth}x${extensionInfo.newHeight} pixels. Do NOT crop, letterbox, or change the aspect ratio. Fill every pixel of the light gray extension area — no gray or white pixels should remain.`
  } else if (isChunked && chunkInfo) {
    const chunkW =
      chunkInfo.direction === 'left' || chunkInfo.direction === 'right'
        ? chunkInfo.chunkWidth + chunkInfo.extensionSize
        : chunkInfo.originalWidth
    const chunkH =
      chunkInfo.direction === 'up' || chunkInfo.direction === 'down'
        ? chunkInfo.chunkHeight + chunkInfo.extensionSize
        : chunkInfo.originalHeight
    const dimTarget = hasExtras ? 'IMAGE 1' : 'the input image'
    prompt += `\n\nOUTPUT DIMENSIONS: Return ${outputImage} at exactly ${chunkW}x${chunkH} pixels — the same dimensions as ${dimTarget}.${hasExtras ? ' Do NOT use the dimensions of any reference image.' : ''} Fill every gray pixel in the blank area. Do NOT return a different size or aspect ratio.`

    if (typeof chunkInfo.tileIndex === 'number' && typeof chunkInfo.tileCount === 'number') {
      prompt += `\n\nTILE CONTEXT: This is tile ${chunkInfo.tileIndex + 1} of ${chunkInfo.tileCount} in a larger extension. Any non-gray edge shows content from an already-finished neighbour tile — continue the scene seamlessly across every such edge. Do NOT repeat or mirror content from the existing (non-gray) portions of this or any adjacent tile.`
    }
  }

  // Suppress unused `attempt` lint warning — kept for future temperature-based
  // adjustments (same pattern the route uses).
  void attempt

  return prompt
}

// ── Phase-1 planning prompt ────────────────────────────────────────────────

/**
 * Build the prompt for phase 1 of a two-phase tile generation.
 *
 * Phase 1 receives a scaled planning map of the full extension band:
 *   - Real pixels from the context strip and already-accepted tiles.
 *   - Grey (#B0B0B0) for the blank region of the current tile.
 *   - Red (#FF0000) for blank regions of future tiles (not yet generated).
 *
 * The model must fill only the grey area and leave everything else untouched.
 * Its output is a low-resolution composition guide used in phase 2.
 */
export function buildPlanningPrompt(params: BuildPlanningPromptParams): string {
  const {
    direction,
    tileIndex,
    tileCount,
    customPrompt,
    artStyle,
    sceneBrief,
    referenceImages,
  } = params

  const hasRefs = !!(referenceImages && referenceImages.length > 0)

  const preamble = hasRefs
    ? `MULTI-IMAGE REQUEST — IMAGE ROLES:
- IMAGE 1: your WORKING CANVAS — the planning map described below.
- IMAGE 2, 3, …: REFERENCE ONLY — style or content guides. Do NOT return them.

`
    : ''

  let prompt = `${preamble}PLANNING TASK: You are generating a low-resolution composition plan for tile ${tileIndex + 1} of ${tileCount} in a multi-tile image extension.

You have been given a scaled-down planning map of the full extension band. The map uses three colour regions:
- GREY (#B0B0B0): the blank area for THIS tile — the only region you must fill.
- RED (#FF0000): blank areas reserved for FUTURE tiles (generated later) — leave these exactly as red.
- All other pixels: real scene content (already painted) — preserve these exactly unchanged.

YOUR TASK:
1. Fill EVERY grey pixel with scene content that fits naturally into the overall composition.
2. Leave all red pixels exactly as red (#FF0000) — do NOT fill or modify them.
3. Preserve all non-grey, non-red pixels exactly as they appear.
4. Return the image at the SAME pixel dimensions as the input map.

COMPOSITION RULES:
- The grey area is on the ${direction === 'up' ? 'top' : direction === 'down' ? 'bottom' : direction === 'left' ? 'left' : 'right'} side.
- Continue the existing scene naturally — same horizon, lighting direction, atmosphere, and scale.
- Do NOT introduce subjects or thematic elements that would conflict with the red (future) regions.
- Keep the composition balanced: the red areas will be filled by other tiles in a consistent style.
- This is a planning sketch — focus on correct layout and tonal composition over fine detail.`

  if (artStyle && ART_STYLE_DESCRIPTIONS[artStyle]) {
    prompt += `\n\nARTISTIC STYLE: ${ART_STYLE_DESCRIPTIONS[artStyle]}.`
  }

  if (customPrompt) {
    prompt += `\n\nUSER DIRECTION for the grey area: "${customPrompt}"`
  }

  if (typeof sceneBrief === 'string' && sceneBrief.trim()) {
    prompt += `\n\nSHARED SCENE DIRECTION:\n${sceneBrief.trim()}`
  }

  if (hasRefs && referenceImages) {
    const refLines = referenceImages.map((ref, i) => {
      const label = `IMAGE ${i + 2}`
      const note = ref.description.trim() ? ref.description.trim() : 'general style or scene reference'
      return `- ${label}: ${note}`
    })
    prompt += `\n\nREFERENCE IMAGES:\n${refLines.join('\n')}\nUse these for style and content guidance when filling the grey area.`
  }

  prompt += `\n\nCRITICAL OUTPUT RULES:
- Return the complete image at the SAME dimensions as the input map.
- Every grey (#B0B0B0) pixel must be replaced with scene content.
- Every red (#FF0000) pixel must remain exactly red.
- No seam, colour shift, or brightness jump at the grey↔real boundary.`

  return prompt
}
