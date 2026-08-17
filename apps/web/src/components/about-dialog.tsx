import { Github, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useVersion } from '@/hooks/use-version'

/** 开源仓库地址；仓库迁移时同步修改。 */
export const GITHUB_REPO_URL = 'https://github.com/LilithGames/a2wave'

interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const { t } = useTranslation()
  const { data: version } = useVersion()

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={520}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('about.title')}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 flex items-center gap-3">
          <BrandMark className="size-11" iconClassName="h-5 w-5" />
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">{t('app.name')}</div>
            {version && (
              <div className="text-xs text-muted-foreground">{t('about.version', { version })}</div>
            )}
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('about.description')}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('about.developer')}</p>
        </div>
        <DialogFooter className="-mx-3 mt-4 border-t border-border px-3 pt-3">
          <Button variant="outline" asChild>
            <Link to="/changelog" onClick={() => onOpenChange(false)}>
              <ScrollText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('about.changelog')}
            </Link>
          </Button>
          <Button asChild>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              <Github className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              GitHub
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
