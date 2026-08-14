/**
 * The one control for choosing a mode from a small mutually-exclusive set.
 *
 * Wraps antd `Segmented`, which `docs/agent/design-tokens.md` already names as
 * the single standard for type / mode pickers (SCM Git vs P4, MCP transport, KB
 * source, workspace type, list filters). What the doc could not enforce is the
 * *shape* of each option: the icon-and-label pairing was hand-written at every
 * icon-bearing call site as a bare
 * `<span className="inline-flex items-center gap-1.5">`, and the copies drifted
 * — some passed `h-4 w-4`, others `h-3.5 w-3.5`, so two pickers on the same page
 * did not line up. One site also shipped `size="small"`, which reads as a
 * different control rather than a smaller one.
 *
 * Making the option shape data (`{ value, label, icon }`) rather than markup
 * removes the opportunity to drift: a caller states *what* the option is, and
 * this file decides how it looks. That is the difference between a convention
 * documented in prose and one that cannot be got wrong.
 */

import { Segmented } from 'antd'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ModePickerOption<T extends string> {
  value: T
  /**
   * Usually a translated string. `ReactNode` is allowed because one caller
   * wraps its label in a `Tooltip`; narrowing to `string` would have left that
   * site on the raw antd control and defeated the consolidation.
   */
  label: ReactNode
  /** Rendered before the label at the component's own fixed size. */
  icon?: LucideIcon
  disabled?: boolean
}

export interface ModePickerProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: ModePickerOption<T>[]
  /** Stretch to fill the row; for a picker sitting above a full-width field. */
  block?: boolean
  disabled?: boolean
  className?: string
}

/**
 * One icon size for every picker in the app.
 *
 * `h-4 w-4` matches the design doc and the SCM storage picker, which is the
 * reference implementation users see most.
 */
const ICON_CLASS = 'h-4 w-4'

export function ModePicker<T extends string>({
  value,
  onChange,
  options,
  block,
  disabled,
  className,
}: ModePickerProps<T>) {
  return (
    <Segmented
      block={block}
      disabled={disabled}
      value={value}
      onChange={(next) => onChange(next as T)}
      className={cn(className)}
      options={options.map(
        ({ value: optionValue, label, icon: Icon, disabled: optionDisabled }) => ({
          value: optionValue,
          disabled: optionDisabled,
          label: Icon ? (
            <span className="inline-flex items-center gap-1.5">
              <Icon className={ICON_CLASS} />
              {label}
            </span>
          ) : (
            label
          ),
        }),
      )}
    />
  )
}
