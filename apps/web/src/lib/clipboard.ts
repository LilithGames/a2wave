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
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  scratch.style.pointerEvents = 'none'
  document.body.appendChild(scratch)
  try {
    scratch.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    scratch.remove()
  }
}
