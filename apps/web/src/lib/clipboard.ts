/** Clipboard helper with a fallback for non-secure origins. */

/**
 * Copy `text`, returning whether it worked.
 *
 * `navigator.clipboard` only exists on secure origins (HTTPS or localhost), but
 * this app is routinely reached over plain HTTP on a LAN address — exactly the
 * case a share link is useful in. The `execCommand` path is deprecated, but it
 * is the only fallback there is, and a failed copy is reported to the caller so
 * the UI can show the link instead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or a non-secure context; try the legacy path.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
