'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Icons } from '@/app/components/icons'
import { ART_STYLE_GROUPS } from '@/app/lib/artStyles'
import { buildExtendPrompt, buildGlobalPlanningPrompt, buildRegionalPlanningPrompt } from '@/app/lib/extendPrompt'
import {
  buildRegionalPlanningMap,
  buildTileChunkInfo,
  buildTileInput,
  compositeTileInputWithPlanning,
  computeRegionMapLayout,
  ExtensionTileSpec,
  PlanRegionGrouping,
  PlanRegionSpec,
  PriorRegionResult,
} from '@/app/utils/imageProcessor'
import { MODELS, maskKey } from '@/app/lib/models'
import { Direction, MAX_AI_DIMENSION, ReferenceImage } from '@/app/lib/app'

export function SettingsDrawer({
  open,
  onClose,
  debugMode,
  setDebugMode,
  onGenerate,
  apiKey,
  onEditApiKey,
  onClearApiKey,
  selectedModel,
  setSelectedModel,
}: {
  open: boolean
  onClose: () => void
  debugMode: boolean
  setDebugMode: (v: boolean) => void
  onGenerate: () => void
  apiKey: string
  onEditApiKey: () => void
  onClearApiKey: () => void
  selectedModel: string
  setSelectedModel: (v: string) => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div
        className="fixed inset-0 z-30 anim-fade"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={onClose}
      />
      <aside
        className="fixed right-0 top-0 z-40 flex h-full w-[360px] flex-col anim-slide-up"
        style={{
          background: 'var(--bg-elev)',
          borderLeft: '1px solid var(--border-strong)',
        }}
      >
        <div
          className="flex h-14 shrink-0 items-center justify-between border-b px-5"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 className="text-[14px] font-semibold tracking-tight">Settings</h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icons.X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <Section title="Model">
            <div className="space-y-2">
              {MODELS.map((m) => {
                const active = m.value === selectedModel
                return (
                  <button
                    key={m.value}
                    onClick={() => setSelectedModel(m.value)}
                    className="flex w-full items-start gap-3 rounded-[var(--radius-sm)] p-3 text-left transition-colors"
                    style={{
                      background: active ? 'var(--accent-bg)' : 'var(--surface)',
                      border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border)'}`,
                    }}
                  >
                    <div
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                      style={{
                        border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
                        background: active ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {active && (
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: '#1a1404' }}
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{m.label}</div>
                      <div
                        className="mt-0.5 truncate text-[11px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {m.hint ? `${m.hint} · ` : ''}
                        <code className="font-mono">{m.value}</code>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section title="OpenRouter key">
            {apiKey ? (
              <div
                className="flex items-center gap-3 rounded-[var(--radius-sm)] p-3"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded"
                  style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}
                >
                  <Icons.Key size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium">Key saved locally</div>
                  <div
                    className="truncate font-mono text-[11px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {maskKey(apiKey)}
                  </div>
                </div>
                <button
                  onClick={onEditApiKey}
                  className="icon-btn"
                  aria-label="Edit key"
                  title="Edit key"
                >
                  <Icons.Settings size={14} />
                </button>
                <button
                  onClick={onClearApiKey}
                  className="icon-btn"
                  aria-label="Remove key"
                  title="Remove key"
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={onEditApiKey}
                className="btn btn-secondary w-full justify-start"
              >
                <Icons.Key size={14} />
                Add OpenRouter key
              </button>
            )}
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Stored only in this browser. Get one at{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                openrouter.ai/keys
              </a>
              .
            </p>
          </Section>

          <Section title="Tools">
            <button
              onClick={() => {
                onClose()
                onGenerate()
              }}
              className="btn btn-secondary w-full justify-start"
            >
              <Icons.Sparkle size={15} />
              Generate image from scratch
            </button>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Create a brand-new image from a text description, then extend it.
            </p>
          </Section>

          <Section title="Developer">
            <Toggle
              label="Debug overlay"
              description="Draw seam guides and log Poisson scores to the console."
              checked={debugMode}
              onChange={setDebugMode}
            />
          </Section>

          <Section title="About">
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              Extensions are 38% of the current image dimension. For larger
              extensions, click an edge again after accepting.
            </p>
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              <strong>Tiled mode</strong> activates automatically for large
              images whose extension band exceeds 1 536 px. The band is split
              into full-resolution overlapping tiles generated sequentially, so
              each tile sees its already-painted neighbours as context. Tiled
              extensions produce a single result (no 3-variant selection).
            </p>
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              <strong>Region layer</strong> appears for very large tiled
              extensions (band or scene span more than 2× the API's 1 536 px
              limit). The tile grid is grouped into a handful of regions,
              each planned independently at full 1 536 px resolution — far
              sharper than one whole-scene plan could be. Use the
              Regions / Tiles toggle above the extension band to switch
              layers; each region has its own prompt override, reference
              images, and independent Regenerate action, just like tiles.
              Regenerating a region does not auto-regenerate its tiles — any
              tile already generated from an old region plan is flagged
              &ldquo;Plan changed — stale&rdquo; until you regenerate it. Each
              region's input is roughly half real, deeply-cropped original
              image (however blurry once downscaled) and half new area to
              fill, so the model always has substantial real content to
              anchor the extension against.
            </p>
            <p
              className="mt-3 text-[11px]"
              style={{ color: 'var(--text-muted)' }}
            >
              Seamless blending via Poisson editing (Pérez et al. 2003).
            </p>
          </Section>
        </div>
      </aside>
    </>
  )
}


export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3
        className="mb-3 text-[11px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {title}
      </h3>
      {children}
    </div>
  )
}


export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-[var(--radius-sm)] py-1">
      <div className="flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {description && (
          <div
            className="mt-0.5 text-[12px] leading-snug"
            style={{ color: 'var(--text-muted)' }}
          >
            {description}
          </div>
        )}
      </div>
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{
          background: checked ? 'var(--accent)' : 'var(--surface)',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        }}
      >
        <span
          className="inline-block h-3 w-3 rounded-full transition-transform"
          style={{
            background: checked ? '#1a1404' : 'var(--text-secondary)',
            transform: checked ? 'translateX(18px)' : 'translateX(3px)',
          }}
        />
      </span>
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate modal — text-to-image
// ─────────────────────────────────────────────────────────────────────────────


export function GenerateModal({
  open,
  onClose,
  prompt,
  setPrompt,
  width,
  setWidth,
  height,
  setHeight,
  artStyle,
  setArtStyle,
  generating,
  onGenerate,
  workflowNote,
  sceneBrief,
  setSceneBrief,
  sceneBriefLoading,
  showSceneBrief,
  layerLabel,
}: {
  open: boolean
  onClose: () => void
  prompt: string
  setPrompt: (v: string) => void
  width: number
  setWidth: (v: number) => void
  height: number
  setHeight: (v: number) => void
  artStyle: string
  setArtStyle: (v: string) => void
  generating: boolean
  onGenerate: () => void
  workflowNote?: string | null
  sceneBrief?: string
  setSceneBrief?: (v: string) => void
  sceneBriefLoading?: boolean
  showSceneBrief?: boolean
  layerLabel?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 anim-fade">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}
        onClick={onClose}
      />
      <div
        className="anim-slide-up relative w-full max-w-lg rounded-[var(--radius-lg)] p-6"
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 32px 64px -16px rgba(0,0,0,0.8)',
        }}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-md"
              style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}
            >
              <Icons.Sparkle size={15} />
            </div>
            <h2 className="text-[15px] font-semibold tracking-tight">
              Generate image
            </h2>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icons.X size={16} />
          </button>
        </div>

        {workflowNote && (
          <div
            className="mb-4 rounded-[var(--radius-sm)] px-3 py-2.5 text-[11px] leading-relaxed"
            style={{
              background: 'var(--accent-bg)',
              border: '1px solid var(--accent-border)',
              color: 'var(--text-secondary)',
            }}
          >
            {workflowNote}
          </div>
        )}

        <div className="space-y-4">
          {showSceneBrief && setSceneBrief && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label
                  className="text-[12px] font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Scene direction
                </label>
                {sceneBriefLoading ? (
                  <span
                    className="inline-flex items-center gap-1 text-[10px]"
                    style={{ color: 'var(--accent)' }}
                  >
                    <Icons.Spinner size={10} />
                    Deriving from Near…
                  </span>
                ) : (
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Shared across all layers
                  </span>
                )}
              </div>
              <textarea
                value={sceneBrief ?? ''}
                onChange={(e) => setSceneBrief(e.target.value)}
                disabled={generating || sceneBriefLoading}
                placeholder="Generate the Near layer first — we'll derive palette, lighting, and mood from that prompt. You can edit this before generating Mid, Far, and Sky."
                rows={3}
                className="field resize-none text-[13px] leading-relaxed"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {layerLabel ? `${layerLabel} layer` : 'Description'}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. A wide mountain valley at golden hour, with a winding river through pine forest"
              rows={3}
              className="field resize-none"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Width
              </label>
              <select
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                className="field select-styled"
              >
                {[512, 768, 960, 1024, 1280, 1536, 1920].map((v) => (
                  <option key={v} value={v}>
                    {v}px
                    {v === 1280 ? ' · 720p' : v === 1920 ? ' · 1080p' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Height
              </label>
              <select
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                className="field select-styled"
              >
                {[360, 540, 720, 768, 1024, 1080, 1280, 1536].map((v) => (
                  <option key={v} value={v}>
                    {v}px
                    {v === 720 ? ' · 720p' : v === 1080 ? ' · 1080p' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              Style
            </label>
            <select
              value={artStyle}
              onChange={(e) => setArtStyle(e.target.value)}
              className="field select-styled"
            >
              {ART_STYLE_GROUPS.map((group) =>
                group.options.length === 1 && group.label === 'Match original' ? (
                  <option key={group.options[0].value} value={group.options[0].value}>
                    Photorealistic
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
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={generating} className="btn btn-ghost">
            Cancel
          </button>
          <button
            onClick={onGenerate}
            disabled={generating || !prompt.trim()}
            className="btn btn-primary"
          >
            {generating ? <Icons.Spinner size={14} /> : <Icons.Sparkle size={14} />}
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// API key modal — first-run prompt to BYOK
// ─────────────────────────────────────────────────────────────────────────────


export function ApiKeyModal({
  open,
  initialValue,
  required,
  onSave,
  onSkip,
  onClose,
}: {
  open: boolean
  initialValue: string
  /** If true, the user can't dismiss without entering a key (no Skip / Esc). */
  required: boolean
  onSave: (key: string) => void
  onSkip?: () => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const [reveal, setReveal] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [open, initialValue])

  useEffect(() => {
    if (!open || required) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, required, onClose])

  if (!open) return null

  const trimmed = value.trim()
  const looksValid = trimmed.startsWith('sk-or-') && trimmed.length > 20

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 anim-fade">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
        onClick={() => {
          if (!required) onClose()
        }}
      />
      <div
        className="anim-slide-up relative w-full max-w-md rounded-[var(--radius-lg)] p-6"
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-strong)',
          boxShadow: '0 32px 64px -16px rgba(0,0,0,0.8)',
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-md"
            style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}
          >
            <Icons.Key size={17} />
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight">
              {required ? 'Add your OpenRouter key' : 'OpenRouter API key'}
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Required to generate or extend images.
            </p>
          </div>
          {!required && (
            <button onClick={onClose} className="icon-btn" aria-label="Close">
              <Icons.X size={16} />
            </button>
          )}
        </div>

        <div className="mb-4">
          <div className="relative">
            <input
              ref={inputRef}
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && looksValid) onSave(trimmed)
              }}
              placeholder="sk-or-..."
              className="field pr-10 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="icon-btn absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
              aria-label={reveal ? 'Hide key' : 'Show key'}
              tabIndex={-1}
            >
              {reveal ? <Icons.EyeOff size={14} /> : <Icons.Eye size={14} />}
            </button>
          </div>
          {value && !looksValid && (
            <div
              className="mt-2 flex items-start gap-2 text-[12px]"
              style={{ color: 'var(--danger)' }}
            >
              <Icons.AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>OpenRouter keys start with <code className="font-mono">sk-or-</code>.</span>
            </div>
          )}
        </div>

        <div
          className="mb-4 rounded-[var(--radius-sm)] p-3 text-[12px] leading-relaxed"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          Your key is stored only in this browser&apos;s <code className="font-mono">localStorage</code>.
          It&apos;s sent with each request to your local server, which proxies it to OpenRouter — never logged, never persisted server-side.
        </div>

        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="mb-5 inline-flex items-center gap-1.5 text-[12px] transition-colors"
          style={{ color: 'var(--accent)' }}
        >
          Get a key at openrouter.ai/keys
          <Icons.External size={11} />
        </a>

        <div className="flex items-center justify-between gap-2">
          {!required && onSkip ? (
            <button onClick={onSkip} className="btn btn-ghost">
              Use server env
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={() => onSave(trimmed)}
            disabled={!looksValid}
            className="btn btn-primary"
          >
            <Icons.Check size={14} />
            Save key
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Error toast — slides in at the top, auto-dismisses
// ─────────────────────────────────────────────────────────────────────────────


export function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 6000)
    return () => clearTimeout(t)
  }, [onClose])
  return (
    <div
      className="fixed left-1/2 top-4 z-50 -translate-x-1/2 anim-slide-down"
      role="alert"
    >
      <div
        className="flex items-start gap-3 rounded-[var(--radius)] px-4 py-3"
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid rgba(255, 107, 107, 0.35)',
          boxShadow: '0 16px 40px -12px rgba(0,0,0,0.6)',
          maxWidth: 480,
        }}
      >
        <div className="mt-0.5" style={{ color: 'var(--danger)' }}>
          <Icons.X size={16} />
        </div>
        <div className="flex-1 text-[13px]" style={{ color: 'var(--text)' }}>
          {message}
        </div>
        <button onClick={onClose} className="icon-btn -m-1.5 h-7 w-7">
          <Icons.X size={14} />
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TiledPlanModal (legacy) — kept for reference; superseded by TileExtensionModal
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal per-cell data for the band-grid visualisation. */
export interface TilePlanCell {
  row: number
  col: number
  bandX: number
  bandY: number
  tileWidth: number
  tileHeight: number
  isSkipped: boolean
  /** -1 when isSkipped, otherwise index into tilePreviews / tilePrompts. */
  nonSkippedIndex: number
}

export interface TiledPlanModalProps {
  open: boolean
  direction: 'up' | 'down' | 'left' | 'right'
  bandWidth: number
  bandHeight: number
  contextSize: number
  extensionSize: number
  cells: TilePlanCell[]
  nonSkippedCount: number
  tilePrompts: string[]
  onSetTilePrompt: (idx: number, prompt: string) => void
  tilePreviews: (string | null)[]
  /** Non-skipped index of the tile currently being processed, or null. */
  currentTileIdx: number | null
  awaitingApproval: boolean
  approveEachTile: boolean
  onToggleApprove: (v: boolean) => void
  generating: boolean
  onGenerate: () => void
  onContinue: () => void
  onRegenerate: () => void
  onCancel: () => void
}

const MAX_GRID_W = 560
const MAX_GRID_H = 200

export function TiledPlanModal({
  open,
  direction,
  bandWidth,
  bandHeight,
  contextSize,
  extensionSize,
  cells,
  nonSkippedCount,
  tilePrompts,
  onSetTilePrompt,
  tilePreviews,
  currentTileIdx,
  awaitingApproval,
  approveEachTile,
  onToggleApprove,
  generating,
  onGenerate,
  onContinue,
  onRegenerate,
  onCancel,
}: TiledPlanModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !generating) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, generating, onCancel])

  if (!open) return null

  const scale = Math.min(MAX_GRID_W / bandWidth, MAX_GRID_H / bandHeight, 1)
  const previewW = Math.round(bandWidth * scale)
  const previewH = Math.round(bandHeight * scale)

  const dirArrow: Record<string, string> = {
    up: '↑', down: '↓', left: '←', right: '→',
  }

  const nonSkippedCells = cells.filter((c) => !c.isSkipped)
  const currentCell = currentTileIdx !== null ? nonSkippedCells[currentTileIdx] : null

  return (
    <>
      <div
        className="fixed inset-0 z-50 anim-fade flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        onClick={() => { if (!generating) onCancel() }}
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div
          className="pointer-events-auto flex w-full max-w-[640px] flex-col anim-slide-up rounded-[var(--radius)]"
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            maxHeight: '90vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div
            className="flex h-12 shrink-0 items-center justify-between border-b px-5"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">Tiled Extension</span>
              <span
                className="text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                {dirArrow[direction]} {direction} · {bandWidth}×{bandHeight}
              </span>
            </div>
            {!generating && (
              <button onClick={onCancel} className="icon-btn" aria-label="Close">
                <Icons.X size={14} />
              </button>
            )}
          </div>

          {/* ── Summary bar ─────────────────────────────────────────── */}
          <div
            className="px-5 pt-3 pb-1 text-[11px]"
            style={{ color: 'var(--text-muted)' }}
          >
            {nonSkippedCount} tile{nonSkippedCount !== 1 ? 's' : ''} to generate
            {' · '}ctx {contextSize}px
            {' · '}ext {extensionSize}px
            {generating && currentTileIdx !== null && (
              <span
                className="ml-2 font-medium"
                style={{ color: 'var(--accent)' }}
              >
                Tile {currentTileIdx + 1} / {nonSkippedCount}
              </span>
            )}
          </div>

          {/* ── Band grid ───────────────────────────────────────────── */}
          <div className="px-5 pt-3 pb-4">
            <div
              style={{
                position: 'relative',
                width: previewW,
                height: previewH,
                margin: '0 auto',
                borderRadius: 4,
                overflow: 'hidden',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
              }}
            >
              {cells.map((cell) => {
                const ns = cell.nonSkippedIndex
                const preview = ns >= 0 ? (tilePreviews[ns] ?? null) : null
                const isCurrent = ns === currentTileIdx
                const isDone = preview !== null
                const isAwaiting = isCurrent && awaitingApproval
                const isGenerating = isCurrent && !awaitingApproval && generating

                const cellW = cell.tileWidth * scale
                const cellH = cell.tileHeight * scale
                const showLabel = cellW > 28 && cellH > 18

                let borderColor = 'var(--border)'
                if (isAwaiting) borderColor = 'var(--accent)'
                else if (isGenerating) borderColor = 'var(--accent)'
                else if (isDone) borderColor = 'var(--border-strong)'

                let bg = 'rgba(140,140,160,0.18)'
                if (cell.isSkipped) bg = 'rgba(80,200,120,0.1)'
                else if (isDone) bg = 'transparent'
                else if (isGenerating) bg = 'rgba(120,120,255,0.12)'

                return (
                  <div
                    key={`${cell.row}-${cell.col}`}
                    style={{
                      position: 'absolute',
                      left: Math.round(cell.bandX * scale),
                      top: Math.round(cell.bandY * scale),
                      width: Math.round(cellW),
                      height: Math.round(cellH),
                      boxSizing: 'border-box',
                      border: `1px ${cell.isSkipped || isDone ? 'solid' : 'dashed'} ${borderColor}`,
                      backgroundColor: isDone ? 'transparent' : bg,
                      backgroundImage: isDone ? `url(${preview})` : 'none',
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      transition: 'border-color 0.25s',
                      boxShadow: isAwaiting ? `0 0 0 2px var(--accent)` : 'none',
                    }}
                  >
                    {showLabel && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 2,
                          left: 3,
                          fontSize: 8,
                          lineHeight: 1,
                          color: isDone ? 'rgba(255,255,255,0.85)' : 'var(--text-muted)',
                          textShadow: isDone ? '0 0 4px rgba(0,0,0,0.8)' : 'none',
                          pointerEvents: 'none',
                        }}
                      >
                        {cell.isSkipped
                          ? 'CTX'
                          : isAwaiting
                          ? '?'
                          : isGenerating
                          ? '…'
                          : isDone
                          ? '✓'
                          : `${ns + 1}`}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Per-tile prompts (pre-generation only) ──────────────── */}
          {!generating && !awaitingApproval && nonSkippedCount > 0 && (
            <div
              className="border-t px-5 pt-4 pb-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <p
                className="mb-2 text-[11px] uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Per-tile prompt overrides
              </p>
              <div
                className="space-y-1.5 overflow-y-auto"
                style={{ maxHeight: 148 }}
              >
                {nonSkippedCells.map((cell, idx) => (
                  <div key={`prompt-${idx}`} className="flex items-center gap-2">
                    <span
                      className="shrink-0 text-[11px] tabular-nums"
                      style={{ color: 'var(--text-muted)', width: 60 }}
                    >
                      r{cell.row}×c{cell.col}
                    </span>
                    <input
                      type="text"
                      value={tilePrompts[idx] ?? ''}
                      onChange={(e) => onSetTilePrompt(idx, e.target.value)}
                      placeholder="Leave blank to use global prompt"
                      className="min-w-0 flex-1 rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px]"
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--text)',
                        outline: 'none',
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Approval panel ──────────────────────────────────────── */}
          {awaitingApproval && currentTileIdx !== null && currentCell != null && (
            <div
              className="border-t px-5 pt-4 pb-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="mb-3 flex items-baseline gap-2">
                <span className="text-[13px] font-semibold">
                  Tile {currentTileIdx + 1} / {nonSkippedCount}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  r{currentCell.row}×c{currentCell.col}
                  {' · '}
                  {currentCell.tileWidth}×{currentCell.tileHeight}
                </span>
              </div>

              <input
                type="text"
                value={tilePrompts[currentTileIdx] ?? ''}
                onChange={(e) => onSetTilePrompt(currentTileIdx, e.target.value)}
                placeholder="Override prompt for regeneration…"
                className="mb-3 w-full rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  outline: 'none',
                }}
              />

              <div className="flex gap-2">
                <button onClick={onRegenerate} className="btn btn-ghost">
                  ↺ Regenerate
                </button>
                <button onClick={onContinue} className="btn btn-primary">
                  → Continue
                </button>
              </div>
            </div>
          )}

          {/* ── Footer ──────────────────────────────────────────────── */}
          {!awaitingApproval && (
            <div
              className="flex shrink-0 items-center justify-between border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              {/* Approve-each-tile toggle */}
              <div
                className="flex rounded-[var(--radius-sm)] p-0.5"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {(['pre-approve', 'approve-each'] as const).map((mode) => {
                  const active = mode === 'approve-each' ? approveEachTile : !approveEachTile
                  const label = mode === 'pre-approve' ? 'Pre-approve' : 'Approve each tile'
                  return (
                    <button
                      key={mode}
                      onClick={() => onToggleApprove(mode === 'approve-each')}
                      disabled={generating}
                      className="rounded px-3 py-1 text-[12px] transition-colors"
                      style={{
                        background: active ? 'var(--accent-bg, rgba(99,102,241,0.15))' : 'transparent',
                        color: active ? 'var(--accent, #6366f1)' : 'var(--text-muted)',
                        fontWeight: active ? 600 : 400,
                        border: 'none',
                        cursor: generating ? 'default' : 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={onCancel}
                  disabled={generating && currentTileIdx !== null}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={onGenerate}
                  disabled={generating}
                  className="btn btn-primary"
                >
                  {generating ? (
                    <>
                      <Icons.Spinner size={13} />
                      Generating…
                    </>
                  ) : (
                    <>
                      <Icons.Sparkle size={13} />
                      {`Generate ${nonSkippedCount} tile${nonSkippedCount !== 1 ? 's' : ''}`}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TileExtensionModal — per-tile prompt / input image / result view
// ─────────────────────────────────────────────────────────────────────────────

export interface TileExtensionModalProps {
  open: boolean
  nsIdx: number
  tileSpec: ExtensionTileSpec
  direction: Direction
  /** The per-tile prompt override (may be empty = use global). */
  tilePrompt: string
  globalPrompt: string
  artStyle: string
  layerRole?: string
  sceneBrief?: string
  nonSkippedCount: number
  /** Latest generated result for this tile, or null if not yet generated. */
  preview: string | null
  /**
   * Effective planning slice for this tile (used to build the high-res composite):
   *   - Per-tile override (Phase 2 re-plan result) if the user re-planned.
   *   - Otherwise, the pre-cropped slice from the global plan (Phase 1).
   *   - null = no planning guide available yet.
   */
  planningSlice: string | null
  /** True when this is the next tile in scan order (Retry/Accept enabled). */
  isNextPending: boolean
  /** True while the API call for this tile is in-flight. */
  isGenerating: boolean
  /** True while the plan-slice-as-final-result path is being applied. */
  isAcceptingPlan: boolean
  /** Band canvas needed to build the tile input image preview. */
  bandCanvas: HTMLCanvasElement | null
  /** All non-skipped tile specs — needed to restore accepted-neighbour overlaps. */
  allTileSpecs: ExtensionTileSpec[]
  /** Per non-skipped tile accepted flags — same purpose as allTileSpecs. */
  tileAccepted: boolean[]
  /** User-supplied reference images for this tile. */
  tileReferenceImages: ReferenceImage[]
  onSetTilePrompt: (v: string) => void
  onSetTileReferenceImages: (v: ReferenceImage[]) => void
  /** Trigger Phase 3: generate the high-res tile. */
  onGenerate: () => void
  /** Trigger Phase 2: per-tile plan re-run. */
  onReplan: () => void
  onAccept: () => void
  /**
   * Accept the current planning slice directly as the tile's final result,
   * skipping the Phase 3 high-res refinement call entirely.
   */
  onAcceptPlan: () => void
  onClose: () => void
  /** True when the in-flight generation for this tile is a Phase 2 re-plan. */
  isReplanInProgress: boolean
  /** Set only in regional-plan mode: this tile's owning region, for the breadcrumb + jump link. */
  owningRegion?: { index: number; count: number } | null
  /** Opens the owning region's RegionPlanModal (closes this modal). Only used when owningRegion is set. */
  onJumpToRegion?: () => void
  /** True if this tile's owning region was regenerated after this tile got a result — stale badge. */
  isStale?: boolean
}

export function TileExtensionModal({
  open,
  nsIdx,
  tileSpec,
  direction,
  tilePrompt,
  globalPrompt,
  artStyle,
  layerRole,
  sceneBrief,
  nonSkippedCount,
  preview,
  planningSlice,
  isNextPending,
  isGenerating,
  isAcceptingPlan,
  bandCanvas,
  allTileSpecs,
  tileAccepted,
  tileReferenceImages,
  onSetTilePrompt,
  onSetTileReferenceImages,
  onGenerate,
  onReplan,
  onAccept,
  onAcceptPlan,
  onClose,
  isReplanInProgress,
  owningRegion,
  onJumpToRegion,
  isStale,
}: TileExtensionModalProps) {
  const [inputImageUrl, setInputImageUrl] = useState<string | null>(null)
  const [resultDimensions, setResultDimensions] = useState<{ width: number; height: number } | null>(null)
  /**
   * Composite of the INPUT image with the grey blank region replaced by the
   * low-res planning slice. Same dimensions as the INPUT.
   */
  const [tileSliceUrl, setTileSliceUrl] = useState<string | null>(null)
  /** Tracks which row's hidden file input should be programmatically triggered. */
  const refImageFileInputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Recompute the tile input image whenever the modal opens or the band canvas
  // changes (e.g. after a prior tile is accepted and composited in).
  useEffect(() => {
    if (!open || !bandCanvas) {
      setInputImageUrl(null)
      return
    }
    try {
      setInputImageUrl(buildTileInput(bandCanvas, tileSpec))
    } catch {
      setInputImageUrl(null)
    }
  }, [open, bandCanvas, tileSpec])

  // Build the tile-slice composite: INPUT with a softened planning guide in the
  // blank region (same treatment as the API composite).
  useEffect(() => {
    if (!inputImageUrl || !planningSlice) {
      setTileSliceUrl(null)
      return
    }

    let cancelled = false

    compositeTileInputWithPlanning(inputImageUrl, tileSpec, planningSlice, bandCanvas, allTileSpecs, tileAccepted)
      .then((url) => {
        if (!cancelled) setTileSliceUrl(url)
      })
      .catch(() => {
        if (!cancelled) setTileSliceUrl(planningSlice)
      })

    return () => { cancelled = true }
  }, [inputImageUrl, planningSlice, tileSpec])

  // Read result image dimensions when the preview changes.
  useEffect(() => {
    if (!preview) {
      setResultDimensions(null)
      return
    }
    const img = new Image()
    img.onload = () => setResultDimensions({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setResultDimensions(null)
    img.src = preview
  }, [preview])

  // Close on Escape when not generating or accepting the plan directly.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isGenerating && !isAcceptingPlan) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isGenerating, isAcceptingPlan, onClose])

  if (!open) return null

  // Build the assembled prompt the model will receive so the user can see
  // exactly what will be sent.
  const chunkInfo = buildTileChunkInfo(tileSpec, direction, nsIdx, nonSkippedCount)
  const populatedRefs = tileReferenceImages.filter((r) => r.dataUrl.length > 0)
  const isKeyedLayer = !!layerRole && layerRole !== 'sky'
  const showTwoPhase = nonSkippedCount > 1 && !isKeyedLayer

  const trimmedTilePrompt = tilePrompt.trim() || undefined
  // Mirrors generateTile's split in app/page.tsx: Phase 1/2 (planning) still
  // falls back to the global description, but Phase 3 (refine) only uses an
  // explicit per-tile override once a plan exists — composition is already
  // locked in by then, so the global description shouldn't reappear there.
  const planningEffectivePrompt = trimmedTilePrompt || globalPrompt.trim() || undefined
  const refineEffectivePrompt = showTwoPhase
    ? trimmedTilePrompt
    : (trimmedTilePrompt || globalPrompt.trim() || undefined)

  const assembledPrompt = buildExtendPrompt({
    direction,
    chunkInfo,
    useFullContext: false,
    customPrompt: refineEffectivePrompt ?? null,
    artStyle: artStyle !== 'none' ? artStyle : null,
    layerRole: layerRole ?? null,
    sceneBrief: sceneBrief ?? null,
    referenceImages: populatedRefs.map((r) => ({ description: r.description })),
    hasBakedPlanning: showTwoPhase,
  })

  const planningPromptText = showTwoPhase
    ? buildGlobalPlanningPrompt({
        direction,
        customPrompt: planningEffectivePrompt ?? null,
        artStyle: artStyle !== 'none' ? artStyle : null,
        sceneBrief: sceneBrief ?? null,
        referenceImages: populatedRefs.map((r) => ({ description: r.description })),
      })
    : null

  const canAct = isNextPending && !isGenerating && !isAcceptingPlan
  const hasPreview = preview !== null
  // Combined busy flag for modal-chrome affordances (close, field editing)
  // that should pause for either a real AI call or the local accept-plan step.
  const isBusy = isGenerating || isAcceptingPlan

  const dirArrow: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 anim-fade"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        onClick={() => { if (!isBusy) onClose() }}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto flex w-full max-w-[700px] flex-col anim-slide-up rounded-[var(--radius)]"
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            maxHeight: '90vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div
            className="flex h-12 shrink-0 items-center justify-between border-b px-5"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">
                Tile {nsIdx + 1} / {nonSkippedCount}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {dirArrow[direction]} {direction}
                {' · '}r{tileSpec.row}×c{tileSpec.col}
                {' · '}
                {tileSpec.tileWidth}×{tileSpec.tileHeight}
              </span>
              {!isNextPending && (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    background: 'var(--surface)',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}
                >
                  Awaiting prior tile
                </span>
              )}
              {isStale && (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    background: 'rgba(230,160,50,0.18)',
                    color: 'var(--warning, #e6a032)',
                    border: '1px solid rgba(230,160,50,0.4)',
                  }}
                  title="This tile's owning region was regenerated since — regenerate this tile to catch up"
                >
                  Plan changed — stale
                </span>
              )}
              {owningRegion && (
                <button
                  onClick={onJumpToRegion}
                  disabled={isBusy}
                  className="text-[11px] underline"
                  style={{ color: 'var(--text-muted)' }}
                  title="Open this tile's owning region plan"
                >
                  Region {owningRegion.index + 1} of {owningRegion.count} ↗
                </button>
              )}
            </div>
            {!isBusy && (
              <button onClick={onClose} className="icon-btn" aria-label="Close">
                <Icons.X size={14} />
              </button>
            )}
          </div>

          {/* ── Body ────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-5 px-5 pt-5 pb-6">

            {/* Prompt override */}
            <div>
              <p
                className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Prompt override
              </p>
              <input
                type="text"
                value={tilePrompt}
                onChange={(e) => onSetTilePrompt(e.target.value)}
                placeholder={
                  showTwoPhase
                    ? globalPrompt.trim()
                      ? 'Refinement ignores the global prompt — leave blank for a faithful high-res render, or type a specific instruction for this tile'
                      : 'Leave blank — faithful high-res render of the plan'
                    : globalPrompt.trim()
                    ? `Using global: "${globalPrompt.trim().slice(0, 60)}"`
                    : 'Leave blank — natural scene continuation'
                }
                disabled={isBusy}
                className="w-full rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  outline: 'none',
                  opacity: isBusy ? 0.6 : 1,
                }}
              />
            </div>

            {/* Reference images */}
            <div>
              <p
                className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Reference Images
              </p>

              {/* Existing rows */}
              {tileReferenceImages.length > 0 && (
                <div className="flex flex-col gap-2 mb-2">
                  {tileReferenceImages.map((ref, rowIdx) => (
                    <div key={rowIdx} className="flex items-center gap-2">
                      {/* Hidden file input for this row */}
                      <input
                        ref={(el) => { refImageFileInputRefs.current[rowIdx] = el }}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = (ev) => {
                            const dataUrl = ev.target?.result
                            if (typeof dataUrl !== 'string') return
                            const next = tileReferenceImages.map((r, i) =>
                              i === rowIdx ? { ...r, dataUrl } : r
                            )
                            onSetTileReferenceImages(next)
                          }
                          reader.readAsDataURL(file)
                          // Reset input so the same file can be re-selected.
                          e.target.value = ''
                        }}
                      />

                      {/* Square thumbnail / drop zone */}
                      <div
                        className="shrink-0 relative overflow-hidden rounded-[var(--radius-sm)] cursor-pointer"
                        style={{
                          width: 64,
                          height: 64,
                          border: ref.dataUrl
                            ? '1px solid var(--border-strong)'
                            : '1.5px dashed var(--border)',
                          background: 'var(--surface)',
                          opacity: isBusy ? 0.6 : 1,
                        }}
                        onClick={() => {
                          if (!isBusy) refImageFileInputRefs.current[rowIdx]?.click()
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          if (isBusy) return
                          e.preventDefault()
                          const file = e.dataTransfer.files[0]
                          if (!file || !file.type.startsWith('image/')) return
                          const reader = new FileReader()
                          reader.onload = (ev) => {
                            const dataUrl = ev.target?.result
                            if (typeof dataUrl !== 'string') return
                            const next = tileReferenceImages.map((r, i) =>
                              i === rowIdx ? { ...r, dataUrl } : r
                            )
                            onSetTileReferenceImages(next)
                          }
                          reader.readAsDataURL(file)
                        }}
                        title={ref.dataUrl ? 'Click to replace image' : 'Click or drop an image'}
                      >
                        {ref.dataUrl ? (
                          <img
                            src={ref.dataUrl}
                            alt={`Reference ${rowIdx + 1}`}
                            className="w-full h-full object-cover block"
                            draggable={false}
                          />
                        ) : (
                          <div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <Icons.Image size={20} />
                          </div>
                        )}
                      </div>

                      {/* Description field */}
                      <input
                        type="text"
                        value={ref.description}
                        placeholder="Describe this reference (optional)"
                        disabled={isBusy}
                        className="flex-1 rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                          outline: 'none',
                          opacity: isBusy ? 0.6 : 1,
                        }}
                        onChange={(e) => {
                          const next = tileReferenceImages.map((r, i) =>
                            i === rowIdx ? { ...r, description: e.target.value } : r
                          )
                          onSetTileReferenceImages(next)
                        }}
                      />

                      {/* Remove row */}
                      <button
                        onClick={() => {
                          onSetTileReferenceImages(
                            tileReferenceImages.filter((_, i) => i !== rowIdx)
                          )
                        }}
                        disabled={isBusy}
                        className="icon-btn shrink-0"
                        aria-label="Remove reference image"
                        title="Remove"
                      >
                        <Icons.X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add button */}
              <button
                onClick={() => {
                  onSetTileReferenceImages([
                    ...tileReferenceImages,
                    { dataUrl: '', description: '' },
                  ])
                }}
                disabled={isBusy}
                className="w-full btn btn-ghost text-[12px]"
                style={{ opacity: isBusy ? 0.6 : 1 }}
              >
                + Add reference image
              </button>
            </div>

            {/* Assembled prompt — collapsible */}
            <details>
              <summary
                className="cursor-pointer select-none text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Full assembled prompt ▸
              </summary>
              {planningPromptText && (
                <>
                  <p
                    className="mt-2 mb-1 text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Phase 1 / 2 — Global &amp; Per-tile Planning
                  </p>
                  <pre
                    className="overflow-auto rounded-[var(--radius-sm)] p-3 text-[10px] leading-relaxed whitespace-pre-wrap"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-secondary)',
                      maxHeight: 140,
                    }}
                  >
                    {planningPromptText}
                  </pre>
                  <p
                    className="mt-2 mb-1 text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Phase 3 — High-res Refinement
                  </p>
                </>
              )}
              <pre
                className="mt-2 overflow-auto rounded-[var(--radius-sm)] p-3 text-[10px] leading-relaxed whitespace-pre-wrap"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  maxHeight: 180,
                }}
              >
                {assembledPrompt}
              </pre>
            </details>

            {/* ── Image pipeline ───────────────────────────────────── */}
            {(() => {
              const tileAR = `${tileSpec.tileWidth} / ${tileSpec.tileHeight}`

              // Phase 3 (high-res generation) is in flight when generating but NOT re-planning.
              const isPhase3Generating = isGenerating && !isReplanInProgress

              /** Spinner + pulse overlay used while a phase is in flight. */
              const spinnerOverlay = (size: number) => (
                <>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Icons.Spinner size={size} />
                  </div>
                  <div
                    className="absolute inset-0 animate-pulse"
                    style={{ background: 'rgba(80,80,130,0.3)' }}
                  />
                </>
              )

              // TILE PLAN shows the high-res composite (tile strip + low-res plan
              // overlaid in blank region). Falls back to the plain tile strip when
              // no planning slice is available yet (single-phase or plan not run).
              const tilePlanSrc = tileSliceUrl ?? inputImageUrl

              return (
                <div className="flex gap-4">
                  {/* Cell 1 — Tile Plan (high-res composite sent to the model) */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Tile plan
                    </p>
                    <div
                      className="checker relative overflow-hidden rounded-[var(--radius-sm)]"
                      style={{
                        border: '1px solid var(--border)',
                        aspectRatio: tileAR,
                        background: 'var(--surface)',
                      }}
                    >
                      {isReplanInProgress ? (
                        spinnerOverlay(14)
                      ) : tilePlanSrc ? (
                        <img
                          src={tilePlanSrc}
                          alt="Tile plan"
                          className="w-full h-full object-contain block"
                          draggable={false}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Icons.Spinner size={14} />
                        </div>
                      )}
                    </div>
                    <p
                      className="mt-1.5 font-mono text-[11px] text-center"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {tileSpec.tileWidth} × {tileSpec.tileHeight}
                    </p>
                  </div>

                  {/* Cell 2 — Result (Phase 3 output) */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Result
                    </p>
                    <div
                      className="checker relative overflow-hidden rounded-[var(--radius-sm)]"
                      style={{
                        border: `1px solid ${hasPreview ? 'var(--border-strong)' : 'var(--border)'}`,
                        aspectRatio: tileAR,
                        background: 'var(--surface)',
                      }}
                    >
                      {(isPhase3Generating || isAcceptingPlan) && (
                        spinnerOverlay(16)
                      )}
                      {hasPreview && preview && (
                        <img
                          src={preview}
                          alt="Tile result"
                          className="w-full h-full object-contain block"
                          draggable={false}
                        />
                      )}
                      {!isGenerating && !isAcceptingPlan && !hasPreview && (
                        <div
                          className="absolute inset-0 flex items-center justify-center text-[11px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Not generated yet
                        </div>
                      )}
                    </div>
                    <p
                      className="mt-1.5 font-mono text-[11px] text-center"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {resultDimensions
                        ? `${resultDimensions.width} × ${resultDimensions.height}`
                        : isPhase3Generating
                        ? 'Generating…'
                        : isAcceptingPlan
                        ? 'Applying plan…'
                        : hasPreview
                        ? '…'
                        : '—'}
                    </p>
                  </div>
                </div>
              )
            })()}

            {/* Actions */}
            <div className="flex items-center justify-between">
              <button
                onClick={onClose}
                disabled={isBusy}
                className="btn btn-ghost"
              >
                Close
              </button>

              <div className="flex gap-2">
                {/* Re-plan tile — Phase 2: regenerate the per-tile plan slice */}
                {showTwoPhase && (
                  <button
                    onClick={onReplan}
                    disabled={!canAct}
                    className="btn btn-ghost"
                    title={!isNextPending ? 'Accept prior tiles first' : 'Regenerate the tile plan slice'}
                  >
                    {isReplanInProgress ? (
                      <>
                        <Icons.Spinner size={13} />
                        Re-planning…
                      </>
                    ) : (
                      <>↺ Re-plan tile</>
                    )}
                  </button>
                )}

                {/* Accept plan as-is — skip Phase 3 entirely and use the
                    low-res planning slice (upscaled) as the final tile */}
                {showTwoPhase && (
                  <button
                    onClick={onAcceptPlan}
                    disabled={!canAct || !planningSlice}
                    className="btn btn-ghost"
                    title={
                      !isNextPending
                        ? 'Accept prior tiles first'
                        : !planningSlice
                        ? 'No plan available yet for this tile'
                        : 'Skip refinement — use the plan slice as the final tile'
                    }
                  >
                    {isAcceptingPlan ? (
                      <>
                        <Icons.Spinner size={13} />
                        Applying…
                      </>
                    ) : (
                      <>
                        <Icons.Check size={13} />
                        Accept plan as-is
                      </>
                    )}
                  </button>
                )}

                {/* Regenerate tile — Phase 3: generate the high-res tile */}
                <button
                  onClick={onGenerate}
                  disabled={!canAct}
                  className="btn btn-ghost"
                  title={!isNextPending ? 'Accept prior tiles first' : undefined}
                >
                  {isGenerating && !isReplanInProgress ? (
                    <>
                      <Icons.Spinner size={13} />
                      Generating…
                    </>
                  ) : (
                    <>↺ {hasPreview ? 'Regenerate tile' : 'Generate tile'}</>
                  )}
                </button>

                <button
                  onClick={onAccept}
                  disabled={!canAct || !hasPreview}
                  className="btn btn-primary"
                  title={
                    !isNextPending
                      ? 'Accept prior tiles first'
                      : !hasPreview
                      ? 'Generate this tile first'
                      : undefined
                  }
                >
                  → Accept
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RegionPlanModal — per-region prompt / reference images / result view.
// Sibling of TileExtensionModal for the coarser "region" layer that sits
// between the macro thumbnail and the tile grid in very large extensions.
// ─────────────────────────────────────────────────────────────────────────────

/** Summary of one tile owned by a region, for the "owned tiles" list. */
export interface RegionOwnedTileInfo {
  nsIdx: number
  row: number
  col: number
  isStale: boolean
  hasResult: boolean
  isAccepted: boolean
}

export interface RegionPlanModalProps {
  open: boolean
  regionIdx: number
  regionCount: number
  region: PlanRegionSpec
  direction: Direction
  /** Per-region prompt override (may be empty = use global). */
  regionPrompt: string
  globalPrompt: string
  artStyle: string
  sceneBrief?: string
  /**
   * Last plan input map actually SENT to the API for this region (grey area +
   * carried-forward context), from the most recent successful generation.
   * Used as an immediate fallback while the live preview (below) rebuilds,
   * and as the only source before this region has ever been generated —
   * hence the live preview is what makes the original-image overlap show up
   * even on a region that's never been sent to the API yet.
   */
  planningMap: string | null
  /** Band canvas (source context strip + extension) — needed to live-preview this region's input, including its overlap with the real original image. */
  bandCanvas: HTMLCanvasElement | null
  /** Original, full-resolution source image — needed to pull the deep "half real image" context block into the live preview. */
  sourceImage: string
  imageWidth: number
  imageHeight: number
  contextSize: number
  extensionSize: number
  regionGrouping: PlanRegionGrouping
  nonSkippedTileSpecs: ExtensionTileSpec[]
  tileAccepted: boolean[]
  /** Other regions' latest results, needed to carry forward shared-overlap-tile continuity into this region's live preview. */
  regionResults: (string | null)[]
  regionScales: number[]
  /** Latest filled-in plan result for this region, or null if not yet generated. */
  result: string | null
  isGenerating: boolean
  regionReferenceImages: ReferenceImage[]
  /** Tiles owned by this region, in scan order. */
  ownedTiles: RegionOwnedTileInfo[]
  onSetRegionPrompt: (v: string) => void
  onSetRegionReferenceImages: (v: ReferenceImage[]) => void
  onRegenerate: () => void
  onClose: () => void
  /** Open the given tile's TileExtensionModal (closes this modal). */
  onJumpToTile: (nsIdx: number) => void
}

export function RegionPlanModal({
  open,
  regionIdx,
  regionCount,
  region,
  direction,
  regionPrompt,
  globalPrompt,
  artStyle,
  sceneBrief,
  planningMap,
  bandCanvas,
  sourceImage,
  imageWidth,
  imageHeight,
  contextSize,
  extensionSize,
  regionGrouping,
  nonSkippedTileSpecs,
  tileAccepted,
  regionResults,
  regionScales,
  result,
  isGenerating,
  regionReferenceImages,
  ownedTiles,
  onSetRegionPrompt,
  onSetRegionReferenceImages,
  onRegenerate,
  onClose,
  onJumpToTile,
}: RegionPlanModalProps) {
  const [resultDimensions, setResultDimensions] = useState<{ width: number; height: number } | null>(null)
  const refImageFileInputRefs = useRef<(HTMLInputElement | null)[]>([])
  /**
   * Live client-side preview of this region's plan input — built the same
   * way generateRegionPlan() builds the real one, but computed eagerly on
   * open/change instead of only after a successful API round-trip. Without
   * this, a region that has never been generated yet shows no overlap with
   * the original image at all (planningMap stays null until first success).
   */
  const [liveInputUrl, setLiveInputUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !bandCanvas) {
      setLiveInputUrl(null)
      return
    }
    let cancelled = false
    const priorRegionResults: Array<PriorRegionResult | null> = regionGrouping.regions.map((r, i) =>
      regionResults[i]
        ? { resultUrl: regionResults[i] as string, scale: regionScales[i], bandRect: r.bandRect }
        : null
    )
    buildRegionalPlanningMap(
      bandCanvas,
      nonSkippedTileSpecs,
      tileAccepted,
      regionGrouping,
      region,
      priorRegionResults,
      MAX_AI_DIMENSION,
      { sourceImageDataUrl: sourceImage, direction, imageWidth, imageHeight, contextSize, extensionSize },
    )
      .then(({ mapDataUrl }) => { if (!cancelled) setLiveInputUrl(mapDataUrl) })
      .catch(() => { if (!cancelled) setLiveInputUrl(null) })
    return () => { cancelled = true }
  }, [open, bandCanvas, sourceImage, direction, imageWidth, imageHeight, contextSize, extensionSize, regionGrouping, region, nonSkippedTileSpecs, tileAccepted, regionResults, regionScales])

  useEffect(() => {
    if (!result) {
      setResultDimensions(null)
      return
    }
    const img = new Image()
    img.onload = () => setResultDimensions({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => setResultDimensions(null)
    img.src = result
  }, [result])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isGenerating) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isGenerating, onClose])

  if (!open) return null

  // Prefer the live-rebuilt preview (always reflects the current band canvas
  // and any newly-carried-forward neighbour context); fall back to the last
  // map actually sent to the API while the live one is still (re)computing.
  const regionInputSrc = liveInputUrl ?? planningMap

  const populatedRefs = regionReferenceImages.filter((r) => r.dataUrl.length > 0)
  const effectivePrompt = regionPrompt.trim() || globalPrompt.trim() || undefined
  const assembledPrompt = buildRegionalPlanningPrompt({
    direction,
    regionIndex: regionIdx,
    regionCount,
    customPrompt: effectivePrompt ?? null,
    artStyle: artStyle !== 'none' ? artStyle : null,
    sceneBrief: sceneBrief ?? null,
    referenceImages: populatedRefs.map((r) => ({ description: r.description })),
  })

  const hasResult = result !== null
  const staleCount = ownedTiles.filter((t) => t.isStale).length
  const dirArrow: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' }
  // The map's actual pixel dimensions include the deep original-image
  // context block (see RegionMapLayout in imageProcessor.ts), which is NOT
  // the same aspect ratio as region.bandRect alone — using bandRect here
  // would letterbox the preview with blank space on either side.
  const regionLayout = computeRegionMapLayout(
    { direction, imageWidth, imageHeight, contextSize, extensionSize },
    region.bandRect,
    MAX_AI_DIMENSION,
  )
  const regionAR = `${regionLayout.mapWidth} / ${regionLayout.mapHeight}`

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 anim-fade"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        onClick={() => { if (!isGenerating) onClose() }}
      />

      {/* Panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto flex w-full max-w-[700px] flex-col anim-slide-up rounded-[var(--radius)]"
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            maxHeight: '90vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div
            className="flex h-12 shrink-0 items-center justify-between border-b px-5"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">
                Region {regionIdx + 1} / {regionCount}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {dirArrow[direction]} {direction}
                {' · '}
                {region.bandRect.width}×{region.bandRect.height}
                {' · '}
                {ownedTiles.length} tile{ownedTiles.length === 1 ? '' : 's'}
              </span>
              {staleCount > 0 && (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    background: 'rgba(230,160,50,0.18)',
                    color: 'var(--warning, #e6a032)',
                    border: '1px solid rgba(230,160,50,0.4)',
                  }}
                >
                  {staleCount} tile{staleCount === 1 ? '' : 's'} stale
                </span>
              )}
            </div>
            {!isGenerating && (
              <button onClick={onClose} className="icon-btn" aria-label="Close">
                <Icons.X size={14} />
              </button>
            )}
          </div>

          {/* ── Body ────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-5 px-5 pt-5 pb-6">

            {/* Prompt override */}
            <div>
              <p
                className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Prompt override
              </p>
              <input
                type="text"
                value={regionPrompt}
                onChange={(e) => onSetRegionPrompt(e.target.value)}
                placeholder={
                  globalPrompt.trim()
                    ? `Using global: "${globalPrompt.trim().slice(0, 60)}"`
                    : 'Leave blank — natural scene continuation'
                }
                disabled={isGenerating}
                className="w-full rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  outline: 'none',
                  opacity: isGenerating ? 0.6 : 1,
                }}
              />
            </div>

            {/* Reference images */}
            <div>
              <p
                className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Reference Images
              </p>

              {regionReferenceImages.length > 0 && (
                <div className="flex flex-col gap-2 mb-2">
                  {regionReferenceImages.map((ref, rowIdx) => (
                    <div key={rowIdx} className="flex items-center gap-2">
                      <input
                        ref={(el) => { refImageFileInputRefs.current[rowIdx] = el }}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = (ev) => {
                            const dataUrl = ev.target?.result
                            if (typeof dataUrl !== 'string') return
                            const next = regionReferenceImages.map((r, i) =>
                              i === rowIdx ? { ...r, dataUrl } : r
                            )
                            onSetRegionReferenceImages(next)
                          }
                          reader.readAsDataURL(file)
                          e.target.value = ''
                        }}
                      />

                      <div
                        className="shrink-0 relative overflow-hidden rounded-[var(--radius-sm)] cursor-pointer"
                        style={{
                          width: 64,
                          height: 64,
                          border: ref.dataUrl
                            ? '1px solid var(--border-strong)'
                            : '1.5px dashed var(--border)',
                          background: 'var(--surface)',
                          opacity: isGenerating ? 0.6 : 1,
                        }}
                        onClick={() => {
                          if (!isGenerating) refImageFileInputRefs.current[rowIdx]?.click()
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          if (isGenerating) return
                          e.preventDefault()
                          const file = e.dataTransfer.files[0]
                          if (!file || !file.type.startsWith('image/')) return
                          const reader = new FileReader()
                          reader.onload = (ev) => {
                            const dataUrl = ev.target?.result
                            if (typeof dataUrl !== 'string') return
                            const next = regionReferenceImages.map((r, i) =>
                              i === rowIdx ? { ...r, dataUrl } : r
                            )
                            onSetRegionReferenceImages(next)
                          }
                          reader.readAsDataURL(file)
                        }}
                        title={ref.dataUrl ? 'Click to replace image' : 'Click or drop an image'}
                      >
                        {ref.dataUrl ? (
                          <img
                            src={ref.dataUrl}
                            alt={`Reference ${rowIdx + 1}`}
                            className="w-full h-full object-cover block"
                            draggable={false}
                          />
                        ) : (
                          <div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <Icons.Image size={20} />
                          </div>
                        )}
                      </div>

                      <input
                        type="text"
                        value={ref.description}
                        placeholder="Describe this reference (optional)"
                        disabled={isGenerating}
                        className="flex-1 rounded-[var(--radius-sm)] px-3 py-2 text-[12px]"
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                          outline: 'none',
                          opacity: isGenerating ? 0.6 : 1,
                        }}
                        onChange={(e) => {
                          const next = regionReferenceImages.map((r, i) =>
                            i === rowIdx ? { ...r, description: e.target.value } : r
                          )
                          onSetRegionReferenceImages(next)
                        }}
                      />

                      <button
                        onClick={() => {
                          onSetRegionReferenceImages(
                            regionReferenceImages.filter((_, i) => i !== rowIdx)
                          )
                        }}
                        disabled={isGenerating}
                        className="icon-btn shrink-0"
                        aria-label="Remove reference image"
                        title="Remove"
                      >
                        <Icons.X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => {
                  onSetRegionReferenceImages([
                    ...regionReferenceImages,
                    { dataUrl: '', description: '' },
                  ])
                }}
                disabled={isGenerating}
                className="w-full btn btn-ghost text-[12px]"
                style={{ opacity: isGenerating ? 0.6 : 1 }}
              >
                + Add reference image
              </button>
            </div>

            {/* Assembled prompt — collapsible */}
            <details>
              <summary
                className="cursor-pointer select-none text-[11px] uppercase tracking-wider font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Full assembled prompt ▸
              </summary>
              <pre
                className="mt-2 overflow-auto rounded-[var(--radius-sm)] p-3 text-[10px] leading-relaxed whitespace-pre-wrap"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  maxHeight: 180,
                }}
              >
                {assembledPrompt}
              </pre>
            </details>

            {/* ── Image pipeline ───────────────────────────────────── */}
            <div className="flex gap-4">
              {/* Cell 1 — Region plan input (map sent to the model) */}
              <div className="flex-1 min-w-0">
                <p
                  className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Region input
                </p>
                <div
                  className="checker relative overflow-hidden rounded-[var(--radius-sm)]"
                  style={{
                    border: '1px solid var(--border)',
                    aspectRatio: regionAR,
                    background: 'var(--surface)',
                  }}
                >
                  {regionInputSrc ? (
                    <img
                      src={regionInputSrc}
                      alt="Region plan input"
                      className="w-full h-full object-contain block"
                      draggable={false}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Icons.Spinner size={14} />
                    </div>
                  )}
                </div>
              </div>

              {/* Cell 2 — Region plan result */}
              <div className="flex-1 min-w-0">
                <p
                  className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Region plan result
                </p>
                <div
                  className="checker relative overflow-hidden rounded-[var(--radius-sm)]"
                  style={{
                    border: `1px solid ${hasResult ? 'var(--border-strong)' : 'var(--border)'}`,
                    aspectRatio: regionAR,
                    background: 'var(--surface)',
                  }}
                >
                  {isGenerating && (
                    <>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Icons.Spinner size={16} />
                      </div>
                      <div
                        className="absolute inset-0 animate-pulse"
                        style={{ background: 'rgba(80,80,130,0.3)' }}
                      />
                    </>
                  )}
                  {hasResult && result && (
                    <img
                      src={result}
                      alt="Region plan result"
                      className="w-full h-full object-contain block"
                      draggable={false}
                    />
                  )}
                  {!isGenerating && !hasResult && (
                    <div
                      className="absolute inset-0 flex items-center justify-center text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Not generated yet
                    </div>
                  )}
                </div>
                <p
                  className="mt-1.5 font-mono text-[11px] text-center"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {resultDimensions
                    ? `${resultDimensions.width} × ${resultDimensions.height}`
                    : isGenerating
                    ? 'Generating…'
                    : '—'}
                </p>
              </div>
            </div>

            {/* Owned tiles list */}
            {ownedTiles.length > 0 && (
              <div>
                <p
                  className="mb-1.5 text-[11px] uppercase tracking-wider font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Owned tiles
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ownedTiles.map((t) => (
                    <button
                      key={t.nsIdx}
                      onClick={() => onJumpToTile(t.nsIdx)}
                      className="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] flex items-center gap-1"
                      style={{
                        background: 'var(--surface)',
                        border: `1px solid ${t.isStale ? 'rgba(230,160,50,0.5)' : 'var(--border)'}`,
                        color: t.isAccepted ? 'var(--text)' : 'var(--text-muted)',
                      }}
                      title={`Open tile ${t.nsIdx + 1} (r${t.row}×c${t.col})`}
                    >
                      r{t.row}×c{t.col}
                      {t.isAccepted && <Icons.Check size={10} />}
                      {t.isStale && (
                        <span style={{ color: 'var(--warning, #e6a032)' }}>·stale</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between">
              <button
                onClick={onClose}
                disabled={isGenerating}
                className="btn btn-ghost"
              >
                Close
              </button>

              <button
                onClick={onRegenerate}
                disabled={isGenerating}
                className="btn btn-primary"
              >
                {isGenerating ? (
                  <>
                    <Icons.Spinner size={13} />
                    Generating…
                  </>
                ) : (
                  <>↺ {hasResult ? 'Regenerate region' : 'Generate region'}</>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

