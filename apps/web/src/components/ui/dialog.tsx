import i18n from '@/i18n'
import { cn } from '@/lib/utils'
import { Modal } from 'antd'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  width?: number
  /** 内容区内边距（px），默认 12；叠加在 antd Modal container 自身 padding（上下 20 / 左右 24）之上 */
  padding?: number
  /**
   * Set when the modal body scrolls. Zeroes antd's `.ant-modal-content` padding
   * for THIS modal so the inner padded `<div>` is the single source of padding —
   * a scroll region can then break out to the true modal edge (with `-mr-N pr-N`)
   * and its scrollbar hugs the border instead of floating over the content
   * padding. Non-scrolling modals leave this unset and keep the default padding.
   */
  scrollBody?: boolean
  /** Runs after Ant Design finishes opening or closing the modal. */
  afterOpenChange?: (open: boolean) => void
  /** Accessible label for the top-right close button; defaults to the localized `common.close`. */
  closeLabel?: string
}

function Dialog({
  open,
  onOpenChange,
  children,
  width,
  padding,
  scrollBody,
  afterOpenChange,
  closeLabel,
}: DialogProps) {
  // Separate trigger and content from children
  const trigger: ReactNode = null
  let content: ReactNode = null
  const rest: ReactNode[] = []

  const childArray = Array.isArray(children) ? children : [children]
  for (const child of childArray) {
    if (child && typeof child === 'object' && 'type' in child) {
      if (child.type === DialogContent) {
        content = child
      } else {
        rest.push(child)
      }
    } else {
      rest.push(child)
    }
  }

  return (
    <>
      {rest}
      {content && (
        <Modal
          open={open}
          onCancel={() => onOpenChange(false)}
          afterOpenChange={afterOpenChange}
          footer={null}
          closable={false}
          destroyOnHidden
          centered
          width={width ?? 448}
          styles={{
            // For scroll-body modals, zero antd's .ant-modal-content padding so
            // the inner padded <div> below is the SINGLE source of padding —
            // otherwise a breakout scroll region leaves that content padding as a
            // gap between its scrollbar and the modal border. The wrapper's
            // padding (raised to 20 for scrollBody) restores the visual inset.
            ...(scrollBody ? { content: { padding: 0 } } : {}),
            body: {
              padding: 0,
            },
            root: {
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--color-border)',
              boxShadow: 'var(--shadow-xl)',
              overflow: 'hidden',
              padding: 0,
            },
            mask: {
              backgroundColor: 'var(--color-overlay)',
            },
          }}
        >
          <div className="relative" style={{ padding: padding ?? (scrollBody ? 20 : 12) }}>
            {(content as React.ReactElement<{ children?: ReactNode }>).props.children}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="absolute right-3 top-3 rounded-sm opacity-50 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={closeLabel ?? i18n.t('common.close')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function DialogContent({ className, children }: { className?: string; children: ReactNode }) {
  // This is a marker component — its children are extracted by Dialog
  return <div className={cn(className)}>{children}</div>
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-1.5', className)} {...props} />
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-base font-semibold text-foreground', className)} {...props} />
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-5 flex justify-end gap-2', className)} {...props} />
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
