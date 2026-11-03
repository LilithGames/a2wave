import { Check, X } from 'lucide-react'

export function PasswordPolicyItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-success' : 'text-muted-foreground'}>{label}</span>
    </div>
  )
}
