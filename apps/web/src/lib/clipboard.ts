/**
 * Copy text, including on origins where the async Clipboard API is unavailable.
 *
 * `navigator.clipboard` is gated on a secure context, so it is simply absent on a
 * plain-HTTP deployment — which internal instances routinely are. Without a
 * fallback, copying a value the user can never see again (a CLI token, an
 * invitation link) would silently do nothing there.
 *
 * Returns whether the text actually reached the clipboard, so the caller can say
 * so honestly rather than showing a success state either way.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Present but refused (permissions policy, insecure context): fall through.
  }

  // Deprecated, but the only path that works without a secure context.
  const scratch = document.createElement('textarea')
  scratch.value = text
  // Keep it off-screen and non-interactive so the page does not visibly jump.
  scratch.setAttribute('readonly', '')
  // Off-screen rather than transparent: a zero-opacity node counts as hidden to
  // some engines, which makes the selection — and so the copy — a no-op.
  scratch.style.position = 'fixed'
  scratch.style.top = '0'
  scratch.style.left = '-9999px'
  // A dialog traps focus to its own subtree, so a scratch node parented on
  // <body> never receives the selection and the copy silently no-ops.
  const host = document.activeElement?.closest('[role="dialog"]') ?? document.body
  host.appendChild(scratch)
  try {
    scratch.select()
    scratch.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    scratch.remove()
  }
}
