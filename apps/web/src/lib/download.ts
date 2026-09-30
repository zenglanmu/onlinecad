/** Browser download helpers. */

/**
 * `Uint8Array` → `BlobPart`.
 *
 * Copies through a fresh `ArrayBuffer` so the result is never a view onto a
 * buffer the engine might reuse, and so it stays assignable regardless of the
 * `Uint8Array<ArrayBufferLike>` generics introduced in newer TypeScript libs.
 */
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

export function downloadBytes(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string
): void {
  downloadBlob([toBlobPart(bytes)], fileName, mimeType)
}

function downloadBlob(parts: BlobPart[], fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
