'use client'

import { useEffect, useRef, useState } from 'react'
import { Icons } from '@/app/components/icons'
import type { InpaintState, ReferenceImage } from '@/app/lib/app'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EditPanelProps {
  inpaintState: InpaintState
  onGenerate: (editPrompt: string, referenceImages: ReferenceImage[]) => void
  /** Re-run the global plan (cascades to the change mask + resets tiles). */
  onRerunPlan: () => void
  /** Re-run only the change mask, reusing the current plan (resets tiles). */
  onRerunMask: () => void
  /** Generate or re-generate a single tile. */
  onRerunTile: (tileIdx: number) => void
  /** Sequentially generate every masked tile that has no result yet. */
  onGenerateAllTiles: () => void
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

function LockedPrompt({ value }: { value: string }) {
  return (
    <p
      className="rounded-lg border px-3 py-2 text-[12px] italic"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)', color: 'var(--text-secondary)' }}
    >
      {value}
    </p>
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
  onRerunTile,
}: {
  tilePlan: NonNullable<InpaintState['tilePlan']>
  tileResults: Array<string | null>
  generatingTileIdx: number | null
  onRerunTile: (idx: number) => void
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
          const resultUrl = tileResults[idx]
          const isDone = resultUrl !== null

          return (
            <div
              key={idx}
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
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {isGenerating ? <Spinner /> : `${tile.row + 1},${tile.col + 1}`}
                </div>
              )}

              {/* Generate (pending tiles, always visible) / Re-run (done tiles,
                  revealed on hover). Tiles never run automatically. */}
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
 * Sections accumulate as the pipeline advances — earlier sections lock in
 * place and never disappear:
 *
 *   1. Context preview (always visible)
 *   2. Description + refs input  (input phase — locks when Generate is clicked)
 *   3. Global plan result         (planning → masking → tiling → done)
 *   4. Change-mask overlay        (masking → tiling → done)
 *   5. Tile grid                  (tiling → done)
 *   6. Accept / Re-run            (done)
 */
export function EditPanel({
  inpaintState,
  onGenerate,
  onRerunPlan,
  onRerunMask,
  onRerunTile,
  onGenerateAllTiles,
  onRerun,
  onAccept,
  onClose,
}: EditPanelProps) {
  const {
    phase,
    lowResPreviewUrl,
    globalPlanUrl,
    globalMaskOverlayUrl,
    tilePlan,
    tileResults,
    generatingTileIdx,
    error,
  } = inpaintState

  // ── Local form state ──────────────────────────────────────────────────────
  // Initialise from the state so that re-run resets to the previous values.
  const [editPrompt, setEditPrompt] = useState(inpaintState.editPrompt)
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>(inpaintState.referenceImages)

  // ── Auto-scroll to bottom when the phase advances or a plan arrives ───────
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [phase, globalPlanUrl, globalMaskOverlayUrl, tilePlan])

  // Phase-derived booleans for progressive disclosure.
  // Note: 'tiling' is now an IDLE phase — plan + mask are done and the user runs
  // each tile manually. Only an in-flight LLM call counts as "processing".
  const pastInput     = phase !== 'input'
  const showPlan      = ['planning', 'masking', 'tiling', 'done'].includes(phase)
  // showMask only when a mask was actually generated — not in the fast path where
  // the plan is composited directly and globalMaskOverlayUrl stays null.
  const showMask      = ['masking', 'tiling', 'done'].includes(phase) && globalMaskOverlayUrl !== null
  const showTiles     = tilePlan !== null
  const isGenerating  = generatingTileIdx !== null
  const isStageBusy   = phase === 'planning' || phase === 'masking'
  const isProcessing  = isStageBusy || isGenerating

  const doneCount = tileResults.filter((r) => r !== null).length
  const totalMasked = tilePlan?.tiles.filter((t) => t.maskSubRect !== null).length ?? 0
  const allTilesDone = totalMasked > 0 && doneCount === totalMasked
  // Fast path: phase reaches 'done' with tilePlan null — the plan was composited
  // directly and is ready to accept without any tile generation.
  const isFastPath  = phase === 'done' && tilePlan === null
  const canAccept   = isFastPath || doneCount > 0
  const planReady   = globalPlanUrl !== null
  const maskReady   = globalMaskOverlayUrl !== null

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div ref={bodyRef} className="flex flex-1 flex-col overflow-y-auto">

        {/* ── Section 1: Context preview ─────────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          <SectionLabel>Selection preview</SectionLabel>
          {lowResPreviewUrl
            ? <ImagePreview src={lowResPreviewUrl} alt="Selection preview" />
            : (
              <div
                className="flex h-24 items-center justify-center rounded-lg border text-[12px]"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                <Spinner />
              </div>
            )}
        </div>

        <SectionDivider />

        {/* ── Section 2: Description + refs ─────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          <SectionLabel>Edit description</SectionLabel>

          {!pastInput ? (
            // Active input stage.
            <>
              <textarea
                className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-[12px] outline-none transition-colors"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', minHeight: 80 }}
                placeholder="e.g. replace the tree with a stone tower, keep the lighting identical"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
                rows={3}
              />

              <ReferenceImageUploader images={referenceImages} onChange={setReferenceImages} />

              {error && phase === 'input' && <ErrorBanner message={error} />}

              <button
                className="btn btn-primary w-full"
                disabled={!editPrompt.trim() || !lowResPreviewUrl}
                onClick={() => onGenerate(editPrompt, referenceImages)}
              >
                <Icons.Play size={13} />
                Generate
              </button>
            </>
          ) : (
            // Locked — show the prompt that was submitted.
            <LockedPrompt value={inpaintState.editPrompt} />
          )}
        </div>

        {/* ── Section 3: Global plan ─────────────────────────────────────── */}
        {showPlan && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between">
                <SectionLabel>Global plan</SectionLabel>
                {planReady && (
                  <button
                    className="btn btn-ghost text-[11px]"
                    style={{ padding: '2px 8px', height: 24 }}
                    onClick={onRerunPlan}
                    disabled={isProcessing}
                    title="Re-generate the global plan (also re-runs the change mask)"
                  >
                    <Icons.Refresh size={11} />
                    Re-run
                  </button>
                )}
              </div>

              {phase === 'planning' && !globalPlanUrl ? (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Spinner />
                  <span>Generating global plan…</span>
                </div>
              ) : globalPlanUrl ? (
                <ImagePreview src={globalPlanUrl} alt="Global plan" />
              ) : null}
            </div>
          </>
        )}

        {/* ── Section 4: Change-mask overlay ────────────────────────────── */}
        {showMask && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between">
                <SectionLabel>Change mask</SectionLabel>
                {maskReady && planReady && (
                  <button
                    className="btn btn-ghost text-[11px]"
                    style={{ padding: '2px 8px', height: 24 }}
                    onClick={onRerunMask}
                    disabled={isProcessing}
                    title="Re-extract the change mask from the current plan"
                  >
                    <Icons.Refresh size={11} />
                    Re-run
                  </button>
                )}
              </div>

              {phase === 'masking' && !globalMaskOverlayUrl ? (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Spinner />
                  <span>Extracting change mask…</span>
                </div>
              ) : globalMaskOverlayUrl ? (
                <ImagePreview src={globalMaskOverlayUrl} alt="Change mask overlay" />
              ) : null}
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
                onRerunTile={onRerunTile}
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
