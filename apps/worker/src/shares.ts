/**
 * Published share links.
 *
 * A share link is the one place where a drawing's *original bytes* leave the
 * user's device. The flow is deliberately narrow:
 *
 *   1. the browser has already parsed the drawing and saved its register entry;
 *   2. the user is asked, in so many words, whether to publish the original
 *      file, and picks a lifetime;
 *   3. only then does the browser `POST` the bytes, which this module streams
 *      straight into R2 under `shares/<token>` and records on the drawing row.
 *
 * Everything here is opt-in and reversible: `DELETE .../share` removes both the
 * object and the token, and deleting the drawing removes them too. There is no
 * background upload — a drawing that was never shared has no object in R2.
 *
 * The token is the entire access control: it is 256 bits of CSPRNG output,
 * resolved by an exact match on the indexed `share_token` column.
 */

import type {
  Drawing,
  DrawingFormat,
  PublicShare,
  PublicShareDrawing
} from '@onlinecad/api-contract'
import { HttpError } from './http'
import type { Env } from './types'

/**
 * Upper bound for one shared file. R2 stores far more, but a Worker that
 * accepts an unbounded stream from an unauthenticated caller is a denial-of-
 * service foothold; a few hundred megabytes covers real drawings with room to
 * spare.
 */
export const MAX_SHARE_BYTES = 256 * 1024 * 1024

const TOKEN_BYTES = 32

/** Object key for a token. One object per link, replaced on re-share. */
export function objectKeyForToken(token: string): string {
  return `shares/${token}`
}

/** 256 bits of CSPRNG output, base64url-encoded (no padding). */
export function createShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Content type served back to recipients.
 *
 * Derived from the register's `format` rather than trusted from the upload:
 * `.dwg` has no registered MIME type, so browsers send nothing useful anyway.
 */
export function contentTypeForFormat(format: DrawingFormat): string {
  return format === 'dwg' ? 'application/acad' : 'application/dxf'
}

/**
 * `Content-Disposition` with both an ASCII fallback and RFC 5987 UTF-8 name, so
 * a Chinese file name survives the trip.
 *
 * The fallback drops control characters and quotes (a raw CR/LF in a header is
 * a response-splitting hazard); the RFC 5987 form is percent-encoded, with the
 * handful of characters `encodeURIComponent` leaves alone that `attr-char`
 * forbids escaped too.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  fileName: string
): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  const encoded = encodeURIComponent(fileName).replace(
    /['()*!]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * Stream the request body into R2 and return the stored byte count.
 *
 * The body is never buffered in the Worker: `request.body` is a `ReadableStream`
 * handed to R2, so a 200 MB drawing costs no more memory than a small one.
 *
 * `Content-Length` is required. Without it there is no way to enforce
 * {@link MAX_SHARE_BYTES} before the bytes are already in R2, and a file upload
 * from an unauthenticated caller must not be unbounded. Browsers set this
 * header for a `File`/`Blob` body, which is the only supported caller.
 */
export async function putShareObject(
  env: Env,
  token: string,
  drawing: Drawing,
  request: Request
): Promise<number> {
  const declared = request.headers.get('content-length')
  const length = declared === null ? Number.NaN : Number(declared)

  if (!Number.isFinite(length) || length <= 0) {
    throw new HttpError(400, '缺少图纸文件内容（需要 Content-Length 且非空）。')
  }
  if (length > MAX_SHARE_BYTES) {
    throw new HttpError(
      413,
      `分享文件不能超过 ${Math.floor(MAX_SHARE_BYTES / (1024 * 1024))} MB。`
    )
  }
  if (!request.body) {
    throw new HttpError(400, '缺少图纸文件内容。')
  }

  const stored = await env.BUCKET.put(objectKeyForToken(token), request.body, {
    httpMetadata: {
      contentType: contentTypeForFormat(drawing.format),
      contentDisposition: contentDisposition('inline', drawing.name)
    },
    customMetadata: { drawingId: drawing.id }
  })

  if (!stored) {
    throw new HttpError(500, 'R2 未能保存文件。')
  }
  return stored.size
}

export async function getShareObject(
  env: Env,
  token: string
): Promise<R2ObjectBody | null> {
  return env.BUCKET.get(objectKeyForToken(token))
}

export async function deleteShareObject(env: Env, token: string): Promise<void> {
  await env.BUCKET.delete(objectKeyForToken(token))
}

/** True when the link carries a past expiry. */
export function isExpired(
  share: { expiresAt: string | null },
  now: Date = new Date()
): boolean {
  return share.expiresAt !== null && Date.parse(share.expiresAt) <= now.getTime()
}

/**
 * Strip a register entry down to the fields a public share page may see.
 *
 * Notes and layer names are included so a recipient sees the same header the
 * owner does; nothing that could identify or edit the register entry is.
 */
export function toPublicShare(drawing: Drawing): PublicShare {
  if (!drawing.share) {
    throw new Error('toPublicShare called for a drawing without a share.')
  }
  return {
    share: drawing.share,
    drawing: toPublicShareDrawing(drawing)
  }
}

function toPublicShareDrawing(drawing: Drawing): PublicShareDrawing {
  return {
    name: drawing.name,
    cadVersion: drawing.cadVersion,
    entityCount: drawing.entityCount,
    layerCount: drawing.layerCount,
    layerNames: drawing.layerNames,
    entityTypes: drawing.entityTypes,
    notes: drawing.notes,
    updatedAt: drawing.updatedAt
  }
}
