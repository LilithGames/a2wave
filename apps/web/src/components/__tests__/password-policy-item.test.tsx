import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PasswordPolicyItem } from '../password-policy-item'

describe('PasswordPolicyItem', () => {
  it('renders a satisfied rule in the success color', () => {
    render(<PasswordPolicyItem ok label="At least 8 characters" />)
    expect(screen.getByText('At least 8 characters')).toHaveClass('text-success')
  })

  it('renders an unmet rule in the muted color', () => {
    render(<PasswordPolicyItem ok={false} label="At least 8 characters" />)
    expect(screen.getByText('At least 8 characters')).toHaveClass('text-muted-foreground')
  })
})
