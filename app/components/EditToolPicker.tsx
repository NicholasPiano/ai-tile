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
  { id: 'seam', label: 'Seam', hint: 'Clean stitch lines', Icon: Icons.Seam },
]

/**
 * Exclusive Rect / Lasso / Seam control. Large: two general tools on the
 * first row, Seam full-width underneath. Compact: three equal columns.
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
  const general = EDIT_TOOLS.filter((item) => item.id !== 'seam')
  const seam = EDIT_TOOLS.find((item) => item.id === 'seam')

  const renderButton = (
    item: (typeof EDIT_TOOLS)[number],
    fullWidth: boolean,
  ) => {
    const active = tool === item.id
    return (
      <button
        key={item.id}
        type="button"
        disabled={disabled}
        onClick={() => {
          onSelect(item.id)
        }}
        className={`flex flex-col items-center justify-center text-center ${
          large ? 'gap-1.5 rounded-[var(--radius-lg)]' : 'gap-0.5 rounded-[var(--radius-sm)]'
        } ${fullWidth ? 'col-span-2' : ''}`}
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
        <item.Icon size={large ? 22 : 16} />
        <span className={`font-medium ${large ? 'text-[13px]' : 'text-[11px]'}`}>
          {item.label}
        </span>
        {large ? (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {item.hint}
          </span>
        ) : null}
      </button>
    )
  }

  if (!large) {
    return (
      <div className="grid grid-cols-3 gap-1.5">
        {EDIT_TOOLS.map((item) => renderButton(item, false))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {general.map((item) => renderButton(item, false))}
      {seam ? renderButton(seam, true) : null}
    </div>
  )
}
