import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

export interface SettingsRowProps {
  label: string
  description?: string
  children: ReactNode
  className?: string
  as?: 'div' | 'label'
  disabled?: boolean
  checked?: boolean
  role?: 'radio' | 'switch'
  onClick?: () => void
}

function rowClassName(className: string | undefined, interactive: boolean): string {
  return ['settings-row', interactive ? 'is-interactive' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
}

export function SettingsRow({
  label,
  description,
  children,
  className,
  as = 'div',
  disabled = false,
  checked,
  role,
  onClick,
}: SettingsRowProps): ReactNode {
  const content = (
    <>
      <span className="settings-row-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <span className="settings-row-control">{children}</span>
    </>
  )

  if (onClick) {
    return (
      <button
        className={rowClassName(className, true)}
        type="button"
        role={role}
        aria-checked={role ? checked : undefined}
        aria-pressed={!role ? checked : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }

  if (as === 'label') {
    return <label className={rowClassName(className, false)}>{content}</label>
  }

  return <div className={rowClassName(className, false)}>{content}</div>
}

export function SettingsSwitch({ on }: { on: boolean }): ReactNode {
  return <span className={`settings-switch ${on ? 'on' : ''}`} aria-hidden="true"><i /></span>
}

export function SettingsRadioMark({ selected }: { selected: boolean }): ReactNode {
  return (
    <span className={`settings-radio-mark ${selected ? 'is-selected' : ''}`} aria-hidden="true">
      {selected && <Check size={11} strokeWidth={2} />}
    </span>
  )
}
