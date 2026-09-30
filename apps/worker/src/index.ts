/**
 * Cloudflare Worker entry point.
 *
 * Two responsibilities:
 *
 * 1. **Serve the SPA.** The built Vue app is bound as `ASSETS` and any request
 *    that is not under `/api/` is handed straight to the asset server (with SPA
 *    fallback configured in `wrangler.jsonc`). The Rust/WASM engine ships as two
 *    static files, `/wasm/acadrust_wasm.js` and `/wasm/acadrust_wasm_bg.wasm`,
 *    served the same way — so parsing a drawing costs no server CPU at all.
 *
 * 2. **Own the D1 drawing index.** `/api/*` is a small JSON API over the
 *    metadata table. It never receives drawing bytes: the browser parses and
 *    edits locally, and only derived metadata is posted here.
 */

import {
  clearDrawingShare,
  deleteDrawing,
  getDrawing,
  getDrawingByShareToken,
  getStats,
  listDrawings,
  saveDrawing,
  setDrawingShare,
  updateDrawing
} from './drawings'
import { HttpError, json, methodNotAllowed } from './http'
import {
  contentDisposition,
  contentTypeForFormat,
  createShareToken,
  deleteShareObject,
  getShareObject,
  isExpired,
  putShareObject,
  toPublicShare
} from './shares'
import type { DrawingFormat } from '@onlinecad/api-contract'
import type { Env } from './types'
import type { ResolvedListQuery } from './drawings'
import {
  MAX_BODY_BYTES,
  ValidationError,
  parseDrawingInput,
  parseDrawingPatch
} from './validation'

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 25
/** Upper bound on a share link's lifetime, so a typo cannot mint a link forever. */
const MAX_SHARE_DAYS = 3650

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Defensive: `wrangler.jsonc` routes /api/* to the Worker first, so the
    // asset handler should never see it. Keeping the fallback means the Worker
    // still behaves if it is invoked for any path.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    try {
      return await route(request, env, url)
    } catch (error) {
      return renderError(error, url)
    }
  }
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  // '/api/'.length === 5
  const segments = url.pathname.slice(5).split('/').filter(Boolean)
  const [resource, ...rest] = segments

  switch (resource) {
    case 'health':
      return json({ ok: true, service: 'onlinecad', now: new Date().toISOString() })

    case 'stats':
      if (request.method !== 'GET') {
        throw methodNotAllowed(['GET'], request.method)
      }
      return json(await getStats(env.DB))

    case 'drawings': {
      if (rest.length === 0) {
        if (request.method === 'GET') return listDrawingsRoute(env, url)
        if (request.method === 'POST') return createDrawingRoute(request, env)
        throw methodNotAllowed(['GET', 'POST'], request.method)
      }

      const id = decodeURIComponent(rest[0])
      if (rest.length === 1) return drawingRoute(request, env, id)
      if (rest.length === 2 && rest[1] === 'share') {
        return drawingShareRoute(request, env, url, id)
      }
      throw new HttpError(404, `Unknown API route: ${url.pathname}`)
    }

    // Public, token-addressed reads. The share page must not be able to reach
    // the register at large, so these live behind their own resource.
    case 'shares':
      return publicShareRoute(request, env, url, rest)

    default:
      throw new HttpError(404, `Unknown API route: ${url.pathname}`)
  }
}

async function listDrawingsRoute(env: Env, url: URL): Promise<Response> {
  const params = url.searchParams
  const format = params.get('format')

  if (format !== null && format !== 'dwg' && format !== 'dxf') {
    throw new HttpError(400, 'The "format" filter must be "dwg" or "dxf".')
  }

  const name = params.get('q')?.trim()
  const layer = params.get('layer')?.trim()
  const tag = params.get('tag')?.trim()

  const query: ResolvedListQuery = {
    limit: parsePositiveInt(params.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    offset: parsePositiveInt(params.get('offset'), 0, Number.MAX_SAFE_INTEGER),
    ...(name ? { q: name } : {}),
    ...(format ? { format: format as DrawingFormat } : {}),
    ...(layer ? { layer } : {}),
    ...(tag ? { tag } : {})
  }

  return json(await listDrawings(env.DB, query))
}

async function createDrawingRoute(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  const drawing = await saveDrawing(env.DB, parseDrawingInput(body))
  return json({ drawing }, { status: 201 })
}

async function drawingRoute(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  switch (request.method) {
    case 'GET': {
      const drawing = await getDrawing(env.DB, id)
      if (!drawing) throw new HttpError(404, `No drawing with id ${id}.`)
      return json({ drawing })
    }

    case 'PATCH': {
      const patch = parseDrawingPatch(await readJsonBody(request))
      const drawing = await updateDrawing(env.DB, id, patch)
      if (!drawing) throw new HttpError(404, `No drawing with id ${id}.`)
      return json({ drawing })
    }

    case 'DELETE': {
      const drawing = await getDrawing(env.DB, id)
      if (!drawing) throw new HttpError(404, `No drawing with id ${id}.`)
      // Reap the published file, if any, before the row disappears — otherwise
      // the R2 object would be orphaned with nothing left to point at it.
      if (drawing.share) await deleteShareObject(env, drawing.share.token)
      await deleteDrawing(env.DB, id)
      return json({ deleted: true, id })
    }

    default:
      throw methodNotAllowed(['GET', 'PATCH', 'DELETE'], request.method)
  }
}

/**
 * Publish or revoke a drawing's original file.
 *
 * `POST` streams the file in the request body (metadata like the link's
 * lifetime travels in the query string, because the body is the file). This is
 * the only endpoint that accepts drawing bytes.
 */
async function drawingShareRoute(
  request: Request,
  env: Env,
  url: URL,
  id: string
): Promise<Response> {
  const drawing = await getDrawing(env.DB, id)
  if (!drawing) throw new HttpError(404, `No drawing with id ${id}.`)

  switch (request.method) {
    case 'POST': {
      const expiresAt = resolveExpiresAt(url.searchParams.get('days'))

      // Re-sharing replaces the file. Drop the old object first so a token the
      // same drawing no longer points at cannot keep serving stale bytes.
      if (drawing.share) await deleteShareObject(env, drawing.share.token)

      const token = createShareToken()
      const sizeBytes = await putShareObject(env, token, drawing, request)
      await setDrawingShare(env.DB, id, {
        token,
        fileName: drawing.name,
        sizeBytes,
        expiresAt
      })

      const updated = await getDrawing(env.DB, id)
      if (!updated) throw new HttpError(500, 'The drawing row disappeared after sharing.')
      return json({ drawing: updated }, { status: 201 })
    }

    case 'DELETE': {
      if (!drawing.share) return json({ drawing })
      await deleteShareObject(env, drawing.share.token)
      await clearDrawingShare(env.DB, id)
      const updated = await getDrawing(env.DB, id)
      if (!updated) throw new HttpError(500, 'The drawing row disappeared after revoking its share.')
      return json({ drawing: updated })
    }

    default:
      throw methodNotAllowed(['POST', 'DELETE'], request.method)
  }
}

/** `GET /api/shares/:token` (metadata) and `GET /api/shares/:token/content`. */
async function publicShareRoute(
  request: Request,
  env: Env,
  url: URL,
  rest: string[]
): Promise<Response> {
  if (rest.length === 0 || rest.length > 2) {
    throw new HttpError(404, `Unknown API route: ${url.pathname}`)
  }
  if (request.method !== 'GET') {
    throw methodNotAllowed(['GET'], request.method)
  }

  const token = decodeURIComponent(rest[0])
  const drawing = await getDrawingByShareToken(env.DB, token)
  if (!drawing || !drawing.share) {
    throw new HttpError(404, '分享链接不存在或已被取消。')
  }
  if (isExpired(drawing.share)) {
    throw new HttpError(410, '分享链接已过期。')
  }

  if (rest.length === 1) {
    return json(toPublicShare(drawing))
  }
  if (rest[1] !== 'content') {
    throw new HttpError(404, `Unknown API route: ${url.pathname}`)
  }
  return shareContentRoute(env, url, drawing)
}

async function shareContentRoute(
  env: Env,
  url: URL,
  drawing: Awaited<ReturnType<typeof getDrawingByShareToken>>
): Promise<Response> {
  if (!drawing?.share) throw new HttpError(404, '分享链接不存在或已被取消。')

  const object = await getShareObject(env, drawing.share.token)
  if (!object) {
    // The register advertises a file R2 no longer has. Heal it rather than
    // serving a broken link forever.
    await clearDrawingShare(env.DB, drawing.id)
    throw new HttpError(410, '分享的文件已不存在，链接已失效。')
  }

  const download = url.searchParams.get('download') === '1'
  const headers = new Headers()
  headers.set(
    'content-type',
    object.httpMetadata?.contentType ?? contentTypeForFormat(drawing.share.format)
  )
  headers.set(
    'content-disposition',
    contentDisposition(download ? 'attachment' : 'inline', drawing.share.fileName)
  )
  headers.set('content-length', String(object.size))
  headers.set('etag', object.httpEtag)
  // The URL is the secret, so it is cacheable by the recipient's browser but
  // never by a shared edge cache.
  headers.set('cache-control', 'private, max-age=3600')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(object.body, { headers })
}

/** `?days=7` → an ISO expiry; absent/empty → never expires. */
function resolveExpiresAt(days: string | null): string | null {
  if (days === null || days.trim() === '') return null
  const parsed = Number(days)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_SHARE_DAYS) {
    throw new HttpError(
      400,
      `Share lifetime must be a whole number of days between 1 and ${MAX_SHARE_DAYS}, or omitted for no expiry.`
    )
  }
  return new Date(Date.now() + parsed * 86_400_000).toISOString()
}

/**
 * Read a JSON body, refusing anything large enough to look like a file upload.
 *
 * This is the enforcement point for "the register is metadata only": the API
 * accepts a few tens of kilobytes of JSON, so a caller that mistakenly posts a
 * drawing here is rejected with an explanation. Publishing a file has its own,
 * explicit endpoint — `POST /api/drawings/:id/share`.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(
      413,
      `This endpoint only accepts metadata up to ${MAX_BODY_BYTES} bytes. To publish a drawing file, use the share endpoint.`
    )
  }

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(
      413,
      `This endpoint only accepts metadata up to ${MAX_BODY_BYTES} bytes. To publish a drawing file, use the share endpoint.`
    )
  }
  if (text.trim().length === 0) {
    throw new HttpError(400, 'A JSON request body is required.')
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'The request body must be valid JSON.')
  }
}

function parsePositiveInt(
  value: string | null,
  fallback: number,
  max: number
): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `"${value}" is not a valid non-negative integer.`)
  }
  return Math.min(parsed, max)
}

function renderError(error: unknown, url: URL): Response {
  if (error instanceof HttpError) {
    const init: ResponseInit = { status: error.status }
    if (error.headers) init.headers = error.headers
    return json({ error: error.message }, init)
  }

  if (error instanceof ValidationError) {
    return json({ error: error.message }, { status: 400 })
  }

  const message = error instanceof Error ? error.message : String(error)
  console.error('Unhandled API error', { path: url.pathname, message })
  return json({ error: 'Internal error.' }, { status: 500 })
}
