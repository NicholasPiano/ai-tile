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
   * understands their role relative to the working canvas (IMAGE 1).
   */
  referenceImages?: { description: string }[]
  /**
   * When true, IMAGE 1 is the baked tile-slice composite: the extension area
   * already contains the low-resolution composition plan rather than solid
   * grey. The prompt frames the task as guided super-resolution — clean up
   * and detail that same content to match the high-res context strip, without
   * rearranging composition or inventing new major subjects.
   *
   * User reference images follow immediately as IMAGE 2, 3, … — there is no
   * separate IMAGE slot for a planning guide.
   */
  hasBakedPlanning?: boolean
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

export interface BuildGlobalPlanningPromptParams {
  direction: 'up' | 'down' | 'left' | 'right'
  customPrompt?: string | null
  artStyle?: string | null
  sceneBrief?: string | null
  referenceImages?: { description: string }[]
}

export interface BuildRegionalPlanningPromptParams {
  direction: 'up' | 'down' | 'left' | 'right'
  /** 0-based index of this region among all regions of the extension. */
  regionIndex: number
  regionCount: number
  customPrompt?: string | null
  artStyle?: string | null
  sceneBrief?: string | null
  referenceImages?: { description: string }[]
}

/**
 * Merge the CommandBar global prompt with a tile/region-specific override.
 * Global comes first; specific appends when both are set. Either alone is fine.
 */
export function combineExtendPrompts(
  globalPrompt: string | null | undefined,
  specificPrompt: string | null | undefined,
): string | undefined {
  const global = typeof globalPrompt === 'string' ? globalPrompt.trim() : ''
  const specific = typeof specificPrompt === 'string' ? specificPrompt.trim() : ''
  if (global.length > 0 && specific.length > 0) {
    return `${global}\n\n${specific}`
  }
  if (specific.length > 0) {
    return specific
  }
  if (global.length > 0) {
    return global
  }
  return undefined
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
    hasBakedPlanning,
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

  // Multi-image mode activates when the user has supplied reference images.
  // When hasBakedPlanning is true the planning preview is already composited
  // into IMAGE 1 — there is no separate IMAGE 2 slot for a planning guide.
  const hasRefs = !!(referenceImages && referenceImages.length > 0)
  const hasExtras = hasRefs

  // User refs always start at IMAGE 2 (planning guide is no longer a separate image).
  const refImageOffset = 1

  const multiImagePreamble = hasExtras
    ? `MULTI-IMAGE REQUEST — IMAGE ROLES:
- IMAGE 1: your WORKING CANVAS — the tile strip you must modify and return. This is the only image that determines your output dimensions and content.
- IMAGE 2, 3, …: REFERENCE ONLY — style or content guides supplied by the user. Do NOT return them. Do NOT paste, resize, composite, or substitute them for your output.

`
    : ''

  // Wording switches between single-image and multi-image requests.
  const workingImage = hasExtras ? 'IMAGE 1' : 'this image'
  const layoutLabel = hasExtras ? 'IMAGE 1' : 'THIS IMAGE'
  const outputImage = hasBakedPlanning
    ? (hasExtras ? 'IMAGE 1 with the extension area super-resolved to match the high-resolution context strip' : 'the complete image with the extension area super-resolved to match the high-resolution context strip')
    : (hasExtras ? 'IMAGE 1 with the gray area filled' : 'the complete image with the blank area filled')

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

    if (hasBakedPlanning) {
      // Guided super-resolution: keep plan identity/detail as inspiration,
      // lift quality to match the high-res context strip (low-res → high-res).
      prompt = `${multiImagePreamble}You are an expert at guided image super-resolution and cleanup. You have been given a ${isHorizDir ? 'vertical' : 'horizontal'} strip${hasExtras ? ' (IMAGE 1)' : ''} where the extension area already contains a LOW-RESOLUTION PLAN of the intended content — enough structure and colour to inspire the result. Your job is LOW-RES → HIGH-RES: clean that plan up into full native detail matching the adjacent high-resolution strip.

PIXEL LAYOUT OF ${layoutLabel}:
- ${contextSide.toUpperCase()} ${contextPx}px → HIGH-RESOLUTION existing scene content. This is your QUALITY TARGET and style reference. Preserve these pixels EXACTLY — pixel-perfect, no changes whatsoever.
- ${dirDesc.toUpperCase()} ${extPx}px → LOW-RESOLUTION plan of the same scene continuation (may look soft or slightly blocky from earlier downscaling). This IS the content to enhance — same objects, edges, materials, and placement — not a vague layout sketch to reinterpret.

YOUR TASK:
1. Preserve EVERY pixel in the ${contextSide} ${contextPx}px high-resolution area exactly as-is — do not alter them in any way.
2. Study the ${contextSide} high-resolution strip for target quality: texture density, edge sharpness, microdetail, colour depth, shading model, and realism. The extension MUST reach that same fidelity.
3. Super-resolve / clean up the ${dirDesc} ${extPx}px plan area:
   - KEEP the plan's subjects, silhouettes, spatial layout, proportions, and major colour masses — they are your inspiration with enough detail to follow.
   - ADD the missing high-frequency detail implied by those forms (surface texture, crisp edges, material response, fine shading) as if the same content were captured at the resolution of the ${contextSide} strip.
   - REMOVE soft blur, blocky upsample artifacts, flat posterized patches, and compression mush — replace them with true native detail, do not merely sharpen noise.
   - Do NOT rearrange composition, replace objects, or invent new major subjects that are not already present or clearly implied in the plan.
4. Make the boundary between the high-resolution and enhanced areas completely invisible — no seam, colour shift, or brightness jump.

QUALITY AUTHORITY (critical):
- The high-resolution ${contextSide} context strip sets HOW detailed and sharp the result must look.
- The low-resolution plan sets WHAT is there — enhance and clean it; do not discard it for a loosely related redraw.
- Success looks like the plan's content photographed or rendered at full resolution next to the context strip — continuous scene, continuous quality.

FORBIDDEN OUTPUTS (unless the context strip already uses that exact style):
- Leaving the extension soft, mushy, or blocky like a naive upsample of the plan
- Cartoon, anime, chibi, or illustration-simplified rendering
- Pixel art, 8-bit, 16-bit, or retro-game aesthetics
- Flat shading, posterization, banding, or limited colour palettes
- Visible upscaled blocks, chunky pixels, or mosaic artifacts
- Clip-art, vector-icon, or children's-book simplification
- A loosely related high-res scene that ignores the plan's objects and layout

A result that still looks low-res, or that ignores the plan and invents unrelated content, is a FAILURE.`
    } else {
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
    }
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

  // Art style block — when rendering from a baked plan, never cartoonify;
  // the high-res context strip always wins on fidelity.
  if (artStyle && ART_STYLE_DESCRIPTIONS[artStyle]) {
    prompt += `\n\n7. ARTISTIC STYLE: Create the extended area in ${ART_STYLE_DESCRIPTIONS[artStyle]}`
    prompt += `\n   - Apply this style consistently to the new content`
    prompt += `\n   - Ensure smooth transition from original to styled extension`
    prompt += `\n   - The style should blend naturally with the existing content at the boundary`
    if (hasBakedPlanning) {
      prompt += `\n   - Match the DETAIL LEVEL and rendering fidelity of the high-resolution context strip — do NOT simplify into cartoon or pixel-art aesthetics unless the context strip already uses them`
    }
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
      if (hasBakedPlanning) {
        prompt += `\n   - The user's request applies ONLY to the ${dirDesc} extension area while super-resolving the plan`
      } else {
        prompt += `\n   - The user's request applies ONLY to the new ${direction === 'up' ? 'upper' : direction === 'down' ? 'lower' : direction === 'left' ? 'left' : 'right'} area (the light gray blank space)`
      }
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
  // IMAGE 1 is always the working canvas; user refs start at IMAGE 2.
  if (hasRefs && referenceImages) {
    const refLines = referenceImages.map((ref, i) => {
      const label = `IMAGE ${refImageOffset + 1 + i}`
      const note = ref.description.trim() ? ref.description.trim() : 'general style or scene reference'
      return `- ${label}: ${note}`
    })
    prompt += `\n\nREFERENCE IMAGES: In addition to IMAGE 1 (the working canvas), you have been provided ${referenceImages.length} user reference image${referenceImages.length === 1 ? '' : 's'}:\n${refLines.join('\n')}\nUse these to inform the style, mood, and content of the extension area. The high-resolution pixels in IMAGE 1 remain your primary guide for continuity — blend any reference-inspired content seamlessly with what is already visible in IMAGE 1.`
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
    const fillInstruction = hasBakedPlanning
      ? 'Super-resolve the extension-area plan to full native detail matching the high-resolution context strip — clean up soft/blocky artifacts; keep the plan\'s objects and layout.'
      : 'Fill every gray pixel in the blank area.'
    prompt += `\n\nOUTPUT DIMENSIONS: Return ${outputImage} at exactly ${chunkW}x${chunkH} pixels — the same dimensions as ${dimTarget}.${hasExtras ? ' Do NOT use the dimensions of any reference image.' : ''} ${fillInstruction} Do NOT return a different size or aspect ratio.`

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

  let prompt = `
  ${preamble}

  The WORKING CANVAS uses three colour regions:
- GREY (#B0B0B0): FILL THIS AREA with a continuation of the existing scene. Leaving any grey pixels unchanged is a FAILURE.
- RED (#FF0000): DO NOT MODIFY OR FILL THESE PIXELS. Changing any red pixels is a FAILURE.
- All other pixels: real scene content (already painted) — preserve these exactly unchanged. Changing any non-grey, non-red pixels is a FAILURE.

YOUR TASK:
1. Fill EVERY grey pixel with scene content that fits naturally into the overall composition.
2. Leave all red pixels exactly as red (#FF0000) — do NOT fill or modify them.
3. Preserve all non-grey, non-red pixels exactly as they appear.
4. Return the image at the SAME pixel dimensions as the input map.

COMPOSITION RULES:
- The grey area is on the ${direction === 'up' ? 'top' : direction === 'down' ? 'bottom' : direction === 'left' ? 'left' : 'right'} side.
- Continue the existing scene naturally — same horizon, lighting direction, atmosphere, and scale.
- Do not duplicate, repeat, or mirror content from the existing (non-grey) portions of this or any adjacent tile.
- Do NOT introduce subjects or thematic elements that would conflict with the red (future) regions.
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

// ── Global extension planning prompt ──────────────────────────────────────────

/**
 * Build the prompt for Phase 1 of the three-phase extension flow.
 *
 * Phase 1 receives a scaled planning map of the FULL extension scene:
 *   - Real pixels from the source image and already-accepted tile regions.
 *   - Grey (#B0B0B0) for the ENTIRE unaccepted extension area.
 *   - No red markers — the model fills all grey at once.
 *
 * This prompt is also reused for Phase 2 (per-tile re-plan), where the
 * background context comes from the global plan result and only the current
 * tile's region is grey.
 */
export function buildGlobalPlanningPrompt(params: BuildGlobalPlanningPromptParams): string {
  const { direction, customPrompt, artStyle, sceneBrief, referenceImages } = params
  const hasRefs = !!(referenceImages && referenceImages.length > 0)

  const dirLabel = direction === 'up' ? 'top'
    : direction === 'down' ? 'bottom'
    : direction === 'left' ? 'left'
    : 'right'

  const preamble = hasRefs
    ? `MULTI-IMAGE REQUEST — IMAGE ROLES:
- IMAGE 1: your WORKING CANVAS — the planning map described below.
- IMAGE 2, 3, …: REFERENCE ONLY — style or content guides. Do NOT return them.

`
    : ''

  let prompt = `${preamble}EXTENSION PLAN — LOW-RESOLUTION COMPOSITION PASS.

The WORKING CANVAS shows the full scene: the original source image with the extension area on the ${dirLabel} filled with solid GREY (#B0B0B0). Any non-grey content in the extension area represents already-accepted tiles — preserve those exactly.

COLOUR REGIONS:
- GREY (#B0B0B0): FILL THIS AREA — replace every grey pixel with plausible scene content.
- All other pixels: real scene content — preserve these EXACTLY unchanged.

YOUR TASK:
1. Fill EVERY grey pixel with a continuation of the existing scene.
2. Preserve all non-grey pixels exactly as they appear — do NOT modify them.
3. Return the image at the SAME pixel dimensions as the input.

COMPOSITION RULES:
- Match the EXACT visual style of the source image: same realism level, colour rendering, shading, and art medium. This output is a smaller-resolution version of the same scene — NOT a new art style.
- Continue the existing scene naturally: same horizon line, lighting direction, atmosphere, and scale.
- If the grey area spans multiple columns or rows of tiles, treat the whole grey region as one unified fill target and ensure internal coherence.
- Do not leave any grey (#B0B0B0) pixels unchanged — a fully grey output is a FAILURE.

STYLE RULES (critical):
- Do NOT simplify into cartoon, anime, pixel art, 8-bit, flat-shaded, or clip-art aesthetics unless the source image already uses that exact style.
- Preserve continuous tones, natural textures, and the same colour depth as the source — even at this lower resolution.
- Focus on correct layout and tonal composition; avoid hard outlines, posterized colour bands, and blocky simplified forms.`

  if (artStyle && ART_STYLE_DESCRIPTIONS[artStyle]) {
    prompt += `\n\nARTISTIC STYLE: ${ART_STYLE_DESCRIPTIONS[artStyle]}.`
  }

  if (customPrompt) {
    prompt += `\n\nUSER DIRECTION for the grey extension area: "${customPrompt}"`
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
- Return the complete image at the SAME dimensions as the input.
- Every grey (#B0B0B0) pixel must be replaced with scene content.
- No seam, colour shift, or brightness jump at the grey↔real boundary.`

  return prompt
}

// ── Regional extension planning prompt ────────────────────────────────────────

/**
 * Build the prompt for a single REGION of a regionally-planned extension.
 *
 * Very large extensions (far beyond a single MAX_AI_DIMENSION plan call's
 * resolution budget) are split into several regions, each covering a slice
 * of the tile grid and planned independently at the full MAX_AI_DIMENSION
 * budget — see groupTilesIntoPlanRegions() in imageProcessor.ts. This prompt
 * is the region-scoped counterpart to buildGlobalPlanningPrompt():
 *   - The WORKING CANVAS is only a slice of the full scene, not the whole
 *     source image, so the model needs to know it's one part of something
 *     larger and is free to invent locally-plausible detail rather than
 *     forcing a single tight global composition.
 *   - Any non-grey pixel in the extension area may be either an already-
 *     accepted tile OR the carried-forward edge of the neighbouring region —
 *     both must be preserved exactly, same as buildGlobalPlanningPrompt's
 *     already-accepted-tile handling.
 */
export function buildRegionalPlanningPrompt(params: BuildRegionalPlanningPromptParams): string {
  const {
    direction, regionIndex, regionCount, customPrompt, artStyle, sceneBrief,
    referenceImages,
  } = params
  const hasRefs = !!(referenceImages && referenceImages.length > 0)

  const dirLabel = direction === 'up' ? 'top'
    : direction === 'down' ? 'bottom'
    : direction === 'left' ? 'left'
    : 'right'

  const preamble = hasRefs
    ? `MULTI-IMAGE REQUEST — IMAGE ROLES:
- IMAGE 1: your WORKING CANVAS — the regional planning map described below.
- IMAGE 2, 3, …: REFERENCE ONLY — style or content guides. Do NOT return them.

`
    : ''

  let prompt = `${preamble}EXTENSION PLAN — REGIONAL COMPOSITION PASS (region ${regionIndex + 1} of ${regionCount}).

The WORKING CANVAS shows ONE REGION of a much larger extension — a slice of the source image and extension area on the ${dirLabel}, NOT the full scene. Any non-grey pixel in the extension area is already-decided content: either an already-accepted high-resolution tile, or the carried-forward edge shared with a neighbouring region. Preserve all such pixels EXACTLY.

THIS IS A LOW-RESOLUTION COMPOSITION PASS, NOT A DETAIL PASS: a later high-resolution step sharpens the result, so a blurry but well-continued extension is far more useful than a sharp but disconnected one. Prioritize COHERENCE with the real pixels you can see over inventing new detail: treat every visible non-grey pixel — the source context strip and any carried-forward overlap — as ground truth, and build your fill outward from it, rather than composing something new that merely resembles it.

COLOUR REGIONS:
- GREY (#B0B0B0): FILL THIS AREA — replace every grey pixel with plausible scene content.
- All other pixels: already-decided content — preserve these EXACTLY unchanged.

YOUR TASK:
1. Fill EVERY grey pixel with a direct, literal continuation of the scene visible in this region — extend what's actually there, don't reinterpret or restart it.
2. Preserve all non-grey pixels exactly as they appear — do NOT modify them, including any shared edge carried over from a neighbouring region.
3. Return the image at the SAME pixel dimensions as the input.

COMPOSITION RULES:
- Match the EXACT visual style of the visible pixels: same realism level, colour rendering, shading, and art medium.
- Continue the scene naturally across the shared edges you can see: same horizon line, lighting direction, atmosphere, and scale. The visible edge is your anchor — the fill should look like an obvious, uninterrupted continuation of it, not a new composition that happens to sit next to it.
- This is ONE REGION of a large, busy scene extending far beyond what this canvas shows. You do NOT need to mirror a single exact global layout — treat this region as its own patch of the same environment, free to place independent local detail (background elements, terrain variation, points of interest not visible elsewhere). This freedom applies to what's FAR from any visible edge — right at a visible edge, continuity always wins over novelty.
- Do not leave any grey (#B0B0B0) pixels unchanged — a fully grey output is a FAILURE.

STYLE RULES (critical):
- Do NOT simplify into cartoon, anime, pixel art, 8-bit, flat-shaded, or clip-art aesthetics unless the visible pixels already use that exact style.
- Preserve continuous tones, natural textures, and the same colour depth as the visible pixels — even at this lower resolution.
- Focus on correct layout and tonal composition; avoid hard outlines, posterized colour bands, and blocky simplified forms.`

  if (artStyle && ART_STYLE_DESCRIPTIONS[artStyle]) {
    prompt += `\n\nARTISTIC STYLE: ${ART_STYLE_DESCRIPTIONS[artStyle]}.`
  }

  if (customPrompt) {
    prompt += `\n\nUSER DIRECTION for the grey area of this region: "${customPrompt}"`
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
- Return the complete image at the SAME dimensions as the input.
- Every grey (#B0B0B0) pixel must be replaced with scene content.
- No seam, colour shift, or brightness jump at any grey↔real boundary.`

  return prompt
}
