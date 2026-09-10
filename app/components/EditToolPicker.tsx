'use client'

import { Icons } from '@/app/components/icons'
import type { EditSelectTool } from '@/app/lib/editMask'

const EDIT_TOOLS: {
  id: EditSelectTool
  label: string
  hint: string
  Icon: typeof Icons.Crop
}[] = [
  { id: 'rect', label: 'Rectangle', hint: 'Drag a box', Icon: Icons.Crop },
  { id: 'lasso', label: 'Lasso', hint: 'Draw around the area', Icon: Icons.Lasso },
]

/**
 * Exclusive Rect / Lasso control. `large` is the empty-panel pair;
 * `compact` sits at the top of an active edit session.
 */
export function EditToolPicker({
  tool,
  onSelect,
  disabled = false,
  size,
}: {
  tool: EditSelectTool
  onSelect: (next: EditSelectTool) => void
  disabled?: boolean
  size: 'large' | 'compact'
}) {
  const large = size === 'large'
  return (
    <div className={`grid grid-cols-2 ${large ? 'gap-2' : 'gap-1.5'}`}>
      {EDIT_TOOLS.map(({ id, label, hint, Icon }) => {
        const active = tool === id
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => {
              onSelect(id)
            }}
            className={`flex flex-col items-center justify-center text-center ${
              large ? 'gap-1.5 rounded-[var(--radius-lg)]' : 'gap-0.5 rounded-[var(--radius-sm)]'
            }`}
            style={{
              height: large ? 96 : 52,
              padding: large ? '10px 8px' : '6px 6px',
              background: 'var(--bg-elev)',
              border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border)'}`,
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            <Icon size={large ? 22 : 16} />
            <span className={`font-medium ${large ? 'text-[13px]' : 'text-[11px]'}`}>
              {label}
            </span>
            {large ? (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {hint}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
