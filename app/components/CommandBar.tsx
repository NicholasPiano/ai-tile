'use client'

import { Icons } from '@/app/components/icons'
import { ART_STYLE_GROUPS } from '@/app/lib/artStyles'

export function CommandBar({
  prompt,
  setPrompt,
  artStyle,
  setArtStyle,
  loading,
  hint,
  sceneBrief,
  setSceneBrief,
  sceneBriefLoading,
  onDownload,
  canDownload,
}: {
  prompt: string
  setPrompt: (v: string) => void
  artStyle: string
  setArtStyle: (v: string) => void
  loading: boolean
  hint?: string
  sceneBrief?: string
  setSceneBrief?: (v: string) => void
  sceneBriefLoading?: boolean
  /** Download the completed extension as PNG (Edit-style Save). */
  onDownload?: () => void
  /** True once an extension has been accepted and no tiled session is open. */
  canDownload?: boolean
}) {
  return (
    <div className="relative z-10 flex flex-col items-center gap-2 px-4 pb-6 pt-2">
      {setSceneBrief && (
        <div
          className="anim-slide-up w-full max-w-3xl rounded-[var(--radius-lg)] p-3"
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
          }}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label
              className="text-[11px] font-medium uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Scene direction
            </label>
            {sceneBriefLoading && (
              <span
                className="inline-flex items-center gap-1 text-[10px]"
                style={{ color: 'var(--accent)' }}
              >
                <Icons.Spinner size={10} />
                Updating…
              </span>
            )}
          </div>
          <textarea
            value={sceneBrief ?? ''}
            onChange={(e) => setSceneBrief(e.target.value)}
            disabled={loading || sceneBriefLoading}
            placeholder="Shared art direction for all layers — generated from your Near layer prompt. Edit to steer Mid, Far, and Sky."
            rows={2}
            className="field w-full resize-none text-[13px] leading-relaxed"
          />
        </div>
      )}

      <div
        className="anim-slide-up flex w-full max-w-3xl items-stretch gap-2 rounded-[var(--radius-lg)] p-1.5"
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 12px 32px -12px rgba(0,0,0,0.6)',
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={loading}
          rows={3}
          placeholder={
            hint ?? 'Optional: describe what should appear in the new area…'
          }
          className="field min-h-[4.5rem] flex-1 resize-y bg-transparent px-3 py-2.5 text-[14px] leading-relaxed focus:outline-none"
          style={{ color: 'var(--text)' }}
        />

        <div
          className="hidden items-center self-start sm:flex"
          style={{ borderLeft: '1px solid var(--border)' }}
        >
          <select
            value={artStyle}
            onChange={(e) => setArtStyle(e.target.value)}
            disabled={loading}
            className="select-styled cursor-pointer border-0 bg-transparent py-2 pl-3 pr-7 text-[13px] focus:outline-none"
            style={{ color: 'var(--text-secondary)' }}
            title="Art style for the extension"
          >
            {ART_STYLE_GROUPS.map((group) =>
              group.options.length === 1 && group.label === 'Match original' ? (
                <option key={group.options[0].value} value={group.options[0].value}>
                  {group.options[0].label}
                </option>
              ) : (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )
            )}
          </select>
        </div>

        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            disabled={loading || !canDownload}
            className="btn btn-ghost shrink-0 self-center text-[12px]"
            style={{ padding: '2px 10px', height: 28 }}
            title={
              canDownload
                ? 'Download completed extension as PNG'
                : 'Available after you accept a completed extension'
            }
          >
            <Icons.Download size={12} />
            Save
          </button>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant selector — cycle between AI-generated extension candidates
// ─────────────────────────────────────────────────────────────────────────────

