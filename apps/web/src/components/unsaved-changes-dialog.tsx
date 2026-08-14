import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Blocker } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function UnsavedChangesDialog({
  blocker,
  onDiscard,
}: {
  blocker: Blocker
  onDiscard?: () => void
}) {
  const { t } = useTranslation()
  const isBlocked = blocker.state === 'blocked'

  return (
    <Dialog
      open={isBlocked}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset()
      }}
      width={380}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            {t('common.unsavedTitle')}
          </DialogTitle>
          <DialogDescription>{t('common.unsavedDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => blocker.state === 'blocked' && blocker.reset()}>
            {t('common.stayOnPage')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (blocker.state === 'blocked') {
                onDiscard?.()
                blocker.proceed()
              }
            }}
          >
            {t('common.leaveWithoutSaving')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
