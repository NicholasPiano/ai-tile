'use client'

import { useEffect, useRef, useState } from 'react'
import { EditToolPicker } from '@/app/components/EditToolPicker'
import { Icons } from '@/app/components/icons'
import { isFreeformPath, type EditSelectTool } from '@/app/lib/editMask'
import { PlanOptionCycler } from '@/app/components/Modals'
import {
  INPAINT_VARIANT_COUNT,
  selectedInpaintVariant,
  selectedTileResultUrl,
  tileSlotHasResult,
  tileSlotVersionCount,
  type InpaintState,
  type InpaintTileSlot,
  type ReferenceImage,
} from '@/app/lib/app'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EditPanelProps {
  inpaintState: InpaintState
  editTool: EditSelectTool
  onSelectTool: (tool: EditSelectTool) => void
  onGenerate: (editPrompt: string, referenceImages: ReferenceImage[]) => void
  /**
   * Re-run all four plan options with the given description (clears tiles),
   * same pipeline as the first Generate.
   */
  onRerunPlan: (editPrompt: string) => void
  /** Generate or re-generate a single tile. */
  onRerunTile: (tileIdx: number) => void
  /** Sequentially generate every masked tile that has no result yet. */
  onGenerateAllTiles: () => void
  /** Cycle the visible plan / mask / tile stack (wraps at both ends). */
  onCycleVariant: (delta: 1 | -1) => void
  /** Cycle one tile's refine version (buttons only — no keyboard). */
  onCycleTileRefine: (tileIdx: number, delta: 1 | -1) => void
  onRerun: () => void
  onAccept: () => void
  onClose: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionDivider() {
  return <div className="shrink-0 border-t" style={{ borderColor: 'var(--border)' }} />
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 text-[12px]"
      style={{
        borderColor: 'var(--danger)',
        background: 'rgba(200,40,40,0.08)',
        color: 'var(--danger)',
      }}
    >
      {message}
    </div>
  )
}

function ImagePreview({ src, alt, label }: { src: string; alt: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
      )}
      <div className="checker overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        <img src={src} alt={alt} className="block w-full object-contain" draggable={false} />
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[11px] font-medium uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </span>
  )
}

function Spinner() {
  return <Icons.Spinner size={14} />
}

/**
 * Arrow cycler for the four independent plan variants. Sits above Global
 * plan and swaps every section below it.
 */
function PlanVariantCycler({
  index,
  total,
  disabled,
  onPrev,
  onNext,
}: {
  index: number
  total: number
  disabled: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full border py-0.5 pl-1 pr-2"
      style={{
        borderColor: 'var(--border-strong)',
        background: 'var(--bg-elev)',
      }}
      role="group"
      aria-label="Cycle between plan variants"
    >
      <button
        onClick={onPrev}
        disabled={disabled}
        className="icon-btn h-6 w-6"
        aria-label="Previous variant (←)"
        title="Previous variant (←)"
      >
        <Icons.ArrowLeft size={13} />
      </button>
      <span
        className="font-mono text-[11px] tabular-nums"
        style={{ color: 'var(--text-secondary)' }}
      >
        {`${index + 1} / ${total}`}
      </span>
      <button
        onClick={onNext}
        disabled={disabled}
        className="icon-btn h-6 w-6"
        aria-label="Next variant (→)"
        title="Next variant (→)"
      >
        <Icons.ArrowRight size={13} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference image uploader
// ─────────────────────────────────────────────────────────────────────────────

function ReferenceImageUploader({
  images,
  onChange,
}: {
  images: ReferenceImage[]
  onChange: (images: ReferenceImage[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (files: FileList | null) => {
    if (!files) return
    const pending: Promise<ReferenceImage>[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      pending.push(
        new Promise<ReferenceImage>((resolve) => {
          const reader = new FileReader()
          reader.onload = (ev) => resolve({ dataUrl: (ev.target?.result as string) ?? '', description: '' })
          reader.readAsDataURL(file)
        }),
      )
    }
    Promise.all(pending).then((newImgs) => onChange([...images, ...newImgs])).catch(() => {})
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Reference images (optional)</SectionLabel>
      {images.map((img, idx) => (
        <div key={idx} className="flex items-start gap-2 rounded-lg border p-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)' }}>
          <div className="checker shrink-0 overflow-hidden rounded border" style={{ width: 48, height: 48, borderColor: 'var(--border)' }}>
            <img src={img.dataUrl} alt={`Reference ${idx + 1}`} className="block h-full w-full object-cover" draggable={false} />
          </div>
          <input
            type="text"
            value={img.description}
            onChange={(e) => onChange(images.map((m, i) => (i === idx ? { ...m, description: e.target.value } : m)))}
            placeholder="Optional note…"
            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[11px] outline-none"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          />
          <button onClick={() => onChange(images.filter((_, i) => i !== idx))} className="icon-btn shrink-0" aria-label="Remove">
            <Icons.X size={12} />
          </button>
        </div>
      ))}
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      <button className="btn btn-ghost w-full text-[11px]" onClick={() => inputRef.current?.click()}>
        + Add reference image
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile progress grid — thumbnail per tile with re-run and result preview
// ─────────────────────────────────────────────────────────────────────────────

function TileGrid({
  tilePlan,
  tileResults,
  generatingTileIdx,
  changeMaskOverlayUrl,
  onRerunTile,
  onCycleTileRefine,
}: {
  tilePlan: NonNullable<InpaintState['tilePlan']>
  tileResults: InpaintTileSlot[]
  generatingTileIdx: number | null
  /** Blue-highlight overlay from computeChangeMaskVisuals — used as a pending
   *  tile preview so the user can see where changes fall before generating. */
  changeMaskOverlayUrl: string | null
  onRerunTile: (idx: number) => void
  onCycleTileRefine: (tileIdx: number, delta: 1 | -1) => void
}) {
  const maskedTiles = tilePlan.tiles
    .map((tile, idx) => ({ tile, idx }))
    .filter(({ tile }) => tile.maskSubRect !== null)

  if (maskedTiles.length === 0) return null

  // While any tile is generating, disable the other tile buttons so runs stay
  // sequential and never collide on the shared composite canvas.
  const anyBusy = generatingTileIdx !== null

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{`Tiles (${maskedTiles.length})`}</SectionLabel>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))' }}>
        {maskedTiles.map(({ tile, idx }) => {
          const isGenerating = generatingTileIdx === idx
          const slot = tileResults[idx]
          const resultUrl = selectedTileResultUrl(slot)
          const isDone = tileSlotHasResult(slot)
          const versionCount = tileSlotVersionCount(slot)
          const selectedIdx = slot?.selectedIdx ?? 0

          return (
            <div key={idx} className="flex flex-col gap-1">
              <div
                className="group relative overflow-hidden rounded border"
                style={{
                  aspectRatio: `${tile.w} / ${tile.h}`,
                  borderColor: isGenerating
                    ? 'rgba(60,140,255,0.8)'
                    : isDone
                      ? 'rgba(40,200,80,0.6)'
                      : 'var(--border)',
                  background: 'var(--bg-elev)',
                }}
              >
                {isDone && resultUrl ? (
                  <img src={resultUrl} alt={`Tile ${idx + 1}`} className="block h-full w-full object-cover" draggable={false} />
                ) : changeMaskOverlayUrl && !isGenerating ? (
                  <div
                    className="h-full w-full"
                    style={{
                      backgroundImage: `url(${changeMaskOverlayUrl})`,
                      backgroundSize: `${(tilePlan.contextW / tile.w) * 100}% ${(tilePlan.contextH / tile.h) * 100}%`,
                      backgroundPosition: `-${(tile.x / tile.w) * 100}% -${(tile.y / tile.h) * 100}%`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {isGenerating ? <Spinner /> : `${tile.row + 1},${tile.col + 1}`}
                  </div>
                )}

                {!isGenerating && (
                  <button
                    className={
                      isDone
                        ? 'absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed'
                        : 'absolute inset-0 flex items-center justify-center opacity-100 transition-opacity disabled:cursor-not-allowed disabled:opacity-40'
                    }
                    style={{ background: isDone ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)' }}
                    onClick={() => onRerunTile(idx)}
                    disabled={anyBusy}
                    title={isDone ? `Re-run tile ${idx + 1}` : `Generate tile ${idx + 1}`}
                    aria-label={isDone ? `Re-run tile ${idx + 1}` : `Generate tile ${idx + 1}`}
                  >
                    <Icons.Play size={14} />
                  </button>
                )}
              </div>
              {isDone && versionCount > 1 && (
                <div className="flex justify-center">
                  <PlanOptionCycler
                    index={selectedIdx}
                    total={versionCount}
                    disabled={anyBusy}
                    onPrev={() => onCycleTileRefine(idx, -1)}
                    onNext={() => onCycleTileRefine(idx, 1)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EditPanel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Progressive sidebar panel for the Tiled Inpaint Pipeline.
 *
 * Sections accumulate as the pipeline advances:
 *
 *   1. Context preview    (always visible)
 *   2. Description + refs (input phase — locks when Generate is clicked)
 *   3. Variant cycler + global plan / mask / tiles (planning → tiling → done)
 *   4. Accept / Re-run
 */
export function EditPanel({
  inpaintState,
  editTool,
  onSelectTool,
  onGenerate,
  onRerunPlan,
  onRerunTile,
  onGenerateAllTiles,
  onCycleVariant,
  onCycleTileRefine,
  onRerun,
  onAccept,
  onClose,
}: EditPanelProps) {
  const {
    phase,
    region,
    lowResPreviewUrl,
    lowResContextUrl,
    tilePlan,
    selectedVariantIdx,
    planningCompletedCount,
    generatingTileIdx,
    error,
  } = inpaintState
  const selectedVariant = selectedInpaintVariant(inpaintState)
  const globalPlanUrl = selectedVariant?.globalPlanUrl ?? null
  const changeMaskUrl = selectedVariant?.changeMaskUrl ?? null
  const changeMaskOverlayUrl = selectedVariant?.changeMaskOverlayUrl ?? null
  const tileResults = selectedVariant?.tileResults ?? []

  const selectionW = Math.round(region.selectionRect.w)
  const selectionH = Math.round(region.selectionRect.h)
  const contextW = Math.round(region.contextRect.w)
  const contextH = Math.round(region.contextRect.h)

  // ── Local form state ──────────────────────────────────────────────────────
  // Initialise from the state so that re-run resets to the previous values.
  const [editPrompt, setEditPrompt] = useState(inpaintState.editPrompt)
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>(inpaintState.referenceImages)

  // Auto-scroll only when the pipeline stage changes — not when cycling
  // variants, which swaps plan/mask URLs but should leave scroll in place.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [phase, tilePlan])

  // Phase-derived booleans for progressive disclosure.
  // 'tiling' is an IDLE phase — plan + diff-mask are done, user runs tiles manually.
  const pastInput    = phase !== 'input'
  const showPlan     = ['planning', 'tiling', 'done'].includes(phase)
  const showMask     = changeMaskUrl !== null
  const showTiles    = tilePlan !== null
  const isGenerating = generatingTileIdx !== null
  const isStageBusy  = phase === 'planning'
  const isProcessing = isStageBusy || isGenerating

  const doneCount   = tileResults.filter((slot) => tileSlotHasResult(slot)).length
  const totalMasked = tilePlan?.tiles.filter((t) => t.maskSubRect !== null).length ?? 0
  const allTilesDone = totalMasked > 0 && doneCount === totalMasked
  // Fast path: phase reaches 'done' with tilePlan null — plan composited directly.
  const isFastPath = phase === 'done' && tilePlan === null
  const canAccept  = isFastPath || doneCount > 0
  const planReady  = globalPlanUrl !== null
  /**
   * After a plan exists, show the clean context crop so the baked-in
   * selection stroke does not hide the seam.
   */
  const selectionPreviewUrl = planReady
    ? (lowResContextUrl ?? lowResPreviewUrl)
    : lowResPreviewUrl

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">

        {/* ── Tool switch (clears the area while still in input) ─────────── */}
        <div className="flex flex-col gap-2 p-4 pb-0">
          <EditToolPicker
            tool={editTool}
            onSelect={onSelectTool}
            disabled={pastInput}
            size="compact"
          />
        </div>

        {/* ── Section 1: Context preview ─────────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          <SectionLabel>Selection preview</SectionLabel>
          {selectionPreviewUrl
            ? <ImagePreview src={selectionPreviewUrl} alt="Selection preview" />
            : (
              <div
                className="flex h-24 items-center justify-center rounded-lg border text-[12px]"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                <Spinner />
              </div>
            )}
          <div
            className="flex flex-col gap-0.5 font-mono text-[11px] tabular-nums"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>
              {isFreeformPath(region.selectionPath)
                ? `Freeform ${selectionW} × ${selectionH} px`
                : `Selection ${selectionW} × ${selectionH} px`}
            </span>
            <span>{`Context ${contextW} × ${contextH} px`}</span>
          </div>
        </div>

        <SectionDivider />

        {/* ── Section 2: Description + refs ─────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          <SectionLabel>Edit description</SectionLabel>

          {/* Editable both before the first generation and afterward — a
              changed description takes effect the next time the plan (or a
              tile) is (re-)generated. Disabled only while a call is in flight. */}
          <textarea
            className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-[12px] outline-none transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', minHeight: 80 }}
            placeholder="e.g. replace the tree with a stone tower, keep the lighting identical"
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
            rows={3}
            disabled={isProcessing}
          />

          {!pastInput && <ReferenceImageUploader images={referenceImages} onChange={setReferenceImages} />}

          {error && phase === 'input' && <ErrorBanner message={error} />}

          {!pastInput ? (
            <button
              className="btn btn-primary w-full"
              disabled={!editPrompt.trim() || !lowResPreviewUrl}
              onClick={() => onGenerate(editPrompt, referenceImages)}
            >
              <Icons.Play size={13} />
              Generate
            </button>
          ) : (
            <button
              className="btn btn-ghost w-full"
              disabled={isProcessing || !editPrompt.trim()}
              onClick={() => onRerunPlan(editPrompt)}
              title="Re-generate all four plan options with this description (clears tiles)"
            >
              <Icons.Refresh size={13} />
              Re-run plan with this description
            </button>
          )}
        </div>

        {/* ── Section 3: Variant cycler + global plan ───────────────────── */}
        {showPlan && (
          <>
            <SectionDivider />
            <div className="flex items-center justify-center px-4 pt-4">
              <PlanVariantCycler
                index={selectedVariantIdx}
                total={INPAINT_VARIANT_COUNT}
                disabled={isProcessing || !planReady}
                onPrev={() => onCycleVariant(-1)}
                onNext={() => onCycleVariant(1)}
              />
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between">
                <SectionLabel>Global plan</SectionLabel>
                {planReady && (
                  <button
                    className="btn btn-ghost text-[11px]"
                    style={{ padding: '2px 8px', height: 24 }}
                    onClick={() => onRerunPlan(editPrompt)}
                    disabled={isProcessing || !editPrompt.trim()}
                    title="Re-generate all four plan options (clears tiles)"
                  >
                    <Icons.Refresh size={11} />
                    Re-run
                  </button>
                )}
              </div>

              {phase === 'planning' && !globalPlanUrl ? (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Spinner />
                  <span>
                    {inpaintState.variants.some((variant) => variant.globalPlanUrl !== null)
                      ? 'Generating this global plan…'
                      : `Generating global plans ${planningCompletedCount}/${INPAINT_VARIANT_COUNT}…`}
                  </span>
                </div>
              ) : globalPlanUrl ? (
                <ImagePreview src={globalPlanUrl} alt="Global plan" />
              ) : null}
            </div>
          </>
        )}

        {/* ── Section 4: Change mask ────────────────────────────────────── */}
        {showMask && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              <SectionLabel>Change mask</SectionLabel>
              {changeMaskUrl && (
                <ImagePreview src={changeMaskUrl} alt="Change mask (B&W)" />
              )}
              {changeMaskOverlayUrl && (
                <ImagePreview src={changeMaskOverlayUrl} alt="Change mask overlay" />
              )}
            </div>
          </>
        )}

        {/* ── Section 5: Tile grid ───────────────────────────────────────── */}
        {showTiles && tilePlan && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              {isGenerating ? (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Spinner />
                  <span>{`Generating tile ${(generatingTileIdx ?? 0) + 1}…`}</span>
                </div>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {`${doneCount} of ${totalMasked} tiles generated. Run each tile below, or generate them all.`}
                </p>
              )}

              <button
                className="btn btn-primary w-full"
                onClick={onGenerateAllTiles}
                disabled={isProcessing || allTilesDone}
              >
                <Icons.Play size={13} />
                {doneCount === 0 ? 'Generate all tiles' : 'Generate remaining tiles'}
              </button>

              <TileGrid
                tilePlan={tilePlan}
                tileResults={tileResults}
                generatingTileIdx={generatingTileIdx}
                changeMaskOverlayUrl={changeMaskOverlayUrl}
                onRerunTile={onRerunTile}
                onCycleTileRefine={onCycleTileRefine}
              />
            </div>
          </>
        )}

        {/* ── Error banner (shown when not in input phase) ───────────────── */}
        {error && phase !== 'input' && (
          <div className="p-4 pt-0">
            <ErrorBanner message={error} />
          </div>
        )}

        {/* ── Section 6: Accept / Re-run from start ─────────────────────── */}
        {pastInput && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              {canAccept && (
                <>
                  <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {isFastPath
                      ? 'Plan is ready — accept to apply the changes.'
                      : allTilesDone
                        ? `All ${doneCount} tile${doneCount !== 1 ? 's' : ''} generated.`
                        : `${doneCount} of ${totalMasked} tiles generated — you can accept now or keep going.`}
                  </p>
                  <button
                    className="btn btn-primary w-full"
                    onClick={() => {
                      console.log('[EditPanel] Accept clicked — calling onAccept')
                      onAccept()
                    }}
                    disabled={isProcessing}
                  >
                    <Icons.Check size={14} />
                    Accept
                  </button>
                </>
              )}
              <button className="btn btn-ghost w-full" onClick={onRerun} disabled={isProcessing}>
                Re-run from start
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
