'use client'

import { useEffect, useRef, useState } from 'react'
import { Icons } from '@/app/components/icons'
import type { InpaintState, ReferenceImage } from '@/app/lib/app'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type MaskMode = 'rect' | 'image'

export interface EditPanelProps {
  inpaintState: InpaintState
  apiKey: string
  model: string
  onMaskConfirm: (maskMode: MaskMode, description: string) => void
  onPromptConfirm: (editPrompt: string, referenceImages: ReferenceImage[]) => void
  onAccept: () => void
  onDiscard: () => void
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

function LockedValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>{label}</SectionLabel>
      <p
        className="rounded-lg border px-3 py-2 text-[12px] italic"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-elev)', color: 'var(--text-secondary)' }}
      >
        {value}
      </p>
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
// Tile progress grid
// ─────────────────────────────────────────────────────────────────────────────

function TileGrid({
  tilePlan,
  tileResults,
  generatingTileIdx,
}: {
  tilePlan: NonNullable<InpaintState['tilePlan']>
  tileResults: Array<string | null>
  generatingTileIdx: number | null
}) {
  const { tiles, contextW, contextH } = tilePlan
  const aspect = contextW / contextH
  const gridH = Math.round(160 / aspect)

  return (
    <div className="relative overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)', width: '100%', height: gridH }}>
      {tiles.map((tile, idx) => {
        const isMasked = tile.maskSubRect !== null
        const isGenerating = generatingTileIdx === idx
        const isDone = tileResults[idx] !== null

        let bg = isMasked ? 'rgba(120,120,120,0.18)' : 'rgba(80,80,80,0.06)'
        if (isDone) bg = 'rgba(40,180,80,0.22)'
        if (isGenerating) bg = 'rgba(60,140,255,0.3)'

        return (
          <div
            key={idx}
            style={{
              position: 'absolute',
              left: `${(tile.x / contextW) * 100}%`,
              top: `${(tile.y / contextH) * 100}%`,
              width: `${(tile.w / contextW) * 100}%`,
              height: `${(tile.h / contextH) * 100}%`,
              background: bg,
              border: isGenerating ? '1.5px solid rgba(60,140,255,0.8)' : '1px solid rgba(255,255,255,0.07)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8, color: 'rgba(255,255,255,0.55)',
            }}
          >
            {isGenerating ? <Icons.Spinner size={8} /> : isDone ? '✓' : ''}
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EditPanel — progressive accumulation layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequential panel: each stage locks in place and the next section appears
 * below it. Sections never disappear once shown.
 *
 *   1. Preview (always visible)
 *   2. Mask    (locked once confirmed)
 *   3. Prompt  (visible after mask confirmed; locked once generation starts)
 *   4. Result  (visible once generation starts)
 */
export function EditPanel({
  inpaintState,
  onMaskConfirm,
  onPromptConfirm,
  onAccept,
  onDiscard,
  onClose,
}: EditPanelProps) {
  const {
    phase,
    region,
    lowResPreviewUrl,
    maskOverlayUrl,
    globalPlanUrl,
    tilePlan,
    tileResults,
    generatingTileIdx,
    maskGenerating,
    error,
    tileDebugInputUrl,
    tileDebugResultUrl,
  } = inpaintState

  // ── Local input state ────────────────────────────────────────────────────
  const [maskMode, setMaskMode] = useState<MaskMode>('rect')
  const [maskDescription, setMaskDescription] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([])

  // ── Auto-scroll to bottom when the phase advances or a plan arrives ───────
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [phase, globalPlanUrl])

  // Phase helpers.
  const pastMask   = phase !== 'mask'
  const showPrompt = ['prompt', 'planning', 'tiling', 'done'].includes(phase)
  const pastPrompt = ['planning', 'tiling', 'done'].includes(phase)
  const showResult = ['planning', 'tiling', 'done'].includes(phase)
  const isDone     = phase === 'done'

  const maskCount = tilePlan?.tiles.filter((t) => t.maskSubRect !== null).length ?? 0
  const doneCount = tileResults.filter((r) => r !== null).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div
        className="flex h-12 shrink-0 items-center justify-between border-b px-4"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Edit</span>
        <button
          onClick={onClose}
          className="icon-btn"
          title="Clear selection"
          aria-label="Clear selection"
          disabled={phase === 'planning' || phase === 'tiling'}
        >
          <Icons.X size={15} />
        </button>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div ref={bodyRef} className="flex flex-1 flex-col overflow-y-auto">

        {/* ── Section 1: Preview ─────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          {lowResPreviewUrl
            ? <ImagePreview src={lowResPreviewUrl} alt="Context preview" label="Context" />
            : (
              <div className="flex h-24 items-center justify-center rounded-lg border text-[12px]" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                <Spinner />
              </div>
            )}
        </div>

        <SectionDivider />

        {/* ── Section 2: Mask ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 p-4">
          <SectionLabel>Mask</SectionLabel>

          {!pastMask ? (
            // Active mask stage — show controls.
            <>
              {(['rect', 'image'] as MaskMode[]).map((m) => (
                <label
                  key={m}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
                  style={{
                    borderColor: maskMode === m ? 'var(--accent)' : 'var(--border)',
                    background: maskMode === m ? 'rgba(var(--accent-rgb),0.06)' : 'var(--bg-elev)',
                  }}
                >
                  <input
                    type="radio"
                    name="maskMode"
                    value={m}
                    checked={maskMode === m}
                    onChange={() => setMaskMode(m)}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                      {m === 'rect' ? 'Selection box' : 'Describe what to mask'}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {m === 'rect' ? 'The entire selected area will be edited' : 'AI generates a precise mask from your description'}
                    </span>
                  </div>
                </label>
              ))}

              {maskMode === 'image' && (
                <textarea
                  className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-[12px] outline-none transition-colors"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)', minHeight: 64 }}
                  placeholder="e.g. the tree, the car, the person on the left…"
                  value={maskDescription}
                  onChange={(e) => setMaskDescription(e.target.value)}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
                  rows={2}
                />
              )}

              {error && phase === 'mask' && <ErrorBanner message={error} />}

              <button
                className="btn btn-primary w-full"
                disabled={maskGenerating || !lowResPreviewUrl || (maskMode === 'image' && !maskDescription.trim())}
                onClick={() => onMaskConfirm(maskMode, maskDescription)}
              >
                {maskGenerating ? <Spinner /> : null}
                {maskGenerating ? 'Generating mask…' : 'Next \u2192'}
              </button>
            </>
          ) : (
            // Locked mask stage — summary + optional mask overlay preview.
            <>
              <LockedValue
                label="Mode"
                value={maskMode === 'rect' ? 'Selection box' : `Described: "${maskDescription}"`}
              />
              {maskOverlayUrl && (
                <ImagePreview src={maskOverlayUrl} alt="Mask overlay" label="Mask" />
              )}
            </>
          )}
        </div>

        {/* ── Section 3: Prompt (shown after mask confirmed) ─────────────── */}
        {showPrompt && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              <SectionLabel>Edit description</SectionLabel>

              {!pastPrompt ? (
                // Active prompt stage.
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

                  {error && phase === 'prompt' && <ErrorBanner message={error} />}

                  <button
                    className="btn btn-primary w-full"
                    disabled={!editPrompt.trim()}
                    onClick={() => onPromptConfirm(editPrompt, referenceImages)}
                  >
                    <Icons.Play size={13} />
                    Generate
                  </button>
                </>
              ) : (
                // Locked prompt stage.
                <LockedValue label="Prompt" value={editPrompt} />
              )}
            </div>
          </>
        )}

        {/* ── Section 4: Result (shown once generation starts) ───────────── */}
        {showResult && (
          <>
            <SectionDivider />
            <div className="flex flex-col gap-3 p-4">
              <SectionLabel>Result</SectionLabel>

              {/* Phase 1: planning */}
              {phase === 'planning' && !globalPlanUrl && (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Spinner />
                  <span>Generating global plan…</span>
                </div>
              )}

              {/* Global plan preview — shown as soon as Phase 1 completes */}
              {globalPlanUrl && (
                <ImagePreview src={globalPlanUrl} alt="Global plan" label="Global plan (Phase 1)" />
              )}

              {/* Phase 2: tile grid + progress */}
              {tilePlan && (
                <>
                  <TileGrid tilePlan={tilePlan} tileResults={tileResults} generatingTileIdx={generatingTileIdx} />
                  {phase === 'tiling' && (
                    <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      <Spinner />
                      <span>{`Tile ${(generatingTileIdx ?? 0) + 1} of ${maskCount}…`}</span>
                    </div>
                  )}
                </>
              )}

              {/* Debug tile previews — shows last tile input & output side-by-side */}
              {(tileDebugInputUrl ?? tileDebugResultUrl) && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Debug: tile comparison
                  </p>
                  <div className="flex gap-1">
                    {tileDebugInputUrl && (
                      <div className="flex-1">
                        <p className="mb-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>Input (sent)</p>
                        <img src={tileDebugInputUrl} alt="Tile input" className="w-full rounded" style={{ border: '1px solid var(--border)' }} />
                      </div>
                    )}
                    {tileDebugResultUrl && (
                      <div className="flex-1">
                        <p className="mb-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>Output (received)</p>
                        <img src={tileDebugResultUrl} alt="Tile result" className="w-full rounded" style={{ border: '1px solid var(--border)' }} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {error && showResult && <ErrorBanner message={error} />}

              {/* Accept / Discard when done */}
              {isDone && (
                <>
                  <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {`${doneCount} tile${doneCount !== 1 ? 's' : ''} generated.`}
                  </p>
                  <div className="flex gap-2">
                    <button className="btn btn-ghost flex-1" onClick={onDiscard}>
                      Discard
                    </button>
                    <button className="btn btn-primary flex-1" onClick={onAccept}>
                      <Icons.Check size={14} />
                      Accept
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  )
}
