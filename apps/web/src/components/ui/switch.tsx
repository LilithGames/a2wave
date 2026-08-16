import { Switch as AntSwitch } from 'antd'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface SwitchProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
  /**
   * Forwarded explicitly because this wrapper destructures its props: anything
   * not named here is silently dropped, so a `data-testid` on a `<Switch>` used
   * to reach the DOM as nothing at all. The selector then matched no element
   * while the switch rendered perfectly, which reads as a broken feature rather
   * than a missing attribute.
   */
  'data-testid'?: string
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      defaultChecked,
      onCheckedChange,
      disabled,
      className,
      'aria-label': ariaLabel,
      'data-testid': testId,
    },
    ref,
  ) => (
    <AntSwitch
      ref={ref as React.Ref<HTMLButtonElement>}
      checked={checked}
      defaultChecked={defaultChecked}
      onChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        '[&.ant-switch]:min-w-9 [&.ant-switch]:h-5',
        '[&.ant-switch-checked]:bg-primary',
        '[&:not(.ant-switch-checked)]:bg-input',
        className,
      )}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  ),
)
Switch.displayName = 'Switch'

export { Switch }
