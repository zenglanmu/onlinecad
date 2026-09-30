/**
 * The HTTP contract between the Worker (`apps/worker`) and the browser app
 * (`apps/web`), plus a typed client for it.
 *
 * It lives in its own package so neither side can drift: the Worker's route
 * handlers and the app's calls are checked against the same declarations.
 *
 * ## The one invariant worth restating
 *
 * The drawing *register* carries metadata only — name, size, CAD version,
 * entity/layer counts and notes. The browser parses, renders and edits locally.
 *
 * Sharing is the single, explicit exception: when a user asks for a link, the
 * original file is uploaded (see {@link DrawingsClient.share}) and served back
 * read-only through {@link SharesClient}. It is a per-drawing opt-in, never a
 * side effect of saving an entry.
 */

export type DrawingFormat = 'dwg' | 'dxf'

/**
 * A published, read-only link to a drawing's original file.
 *
 * The `token` is the whole secret: anyone holding it can read the file, so it
 * is generated with 256 bits of entropy and never derived from the drawing.
 */
export interface DrawingShare {
  token: string
  /** Original file name, used for `Content-Disposition` and the viewer title. */
  fileName: string
  format: DrawingFormat
  sizeBytes: number
  createdAt: string
  /** ISO timestamp when the link stops working, or `null` for no expiry. */
  expiresAt: string | null
}

export interface Drawing {
  id: string
  name: string
  format: DrawingFormat
  sizeBytes: number
  /**
   * SHA-256 of the local file, computed in the browser. Lets the server
   * recognise a file it has already indexed so re-saving updates one entry
   * instead of creating duplicates. It is a fingerprint, not the file.
   */
  contentHash: string | null
  /** Source CAD version code, e.g. `AC1032`. */
  cadVersion: string | null
  entityCount: number
  layerCount: number
  layerNames: string[]
  /** Entity count per DXF entity type, e.g. `{ LINE: 12 }`. */
  entityTypes: Record<string, number>
  notes: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
  /**
   * The active share link, or `null` when this drawing's bytes are still only
   * on the user's device.
   */
  share: DrawingShare | null
}

export interface DrawingInput {
  name: string
  format: DrawingFormat
  sizeBytes: number
  contentHash?: string | null
  cadVersion?: string | null
  entityCount?: number
  layerCount?: number
  layerNames?: string[]
  entityTypes?: Record<string, number>
  notes?: string | null
  tags?: string[]
}

export interface DrawingPatch {
  name?: string
  notes?: string | null
  tags?: string[]
}

/** Options for {@link DrawingsClient.share}. */
export interface ShareInput {
  /**
   * Lifetime of the link in whole days. Omitted or `null` means the link never
   * expires (until it is revoked or the drawing is deleted).
   */
  expiresInDays?: number | null
}

export interface DrawingListQuery {
  /** Substring match on the drawing name. */
  q?: string
  format?: DrawingFormat
  /** Only drawings that contain this layer. */
  layer?: string
  tag?: string
  limit?: number
  offset?: number
}

export interface DrawingList {
  items: Drawing[]
  total: number
}

export interface DrawingStats {
  drawingCount: number
  totalBytes: number
  layerCount: number
  byFormat: Record<string, number>
  topLayers: Array<{ layerName: string; drawingCount: number }>
}

/** Error thrown for any non-2xx API response. */
export class DrawingApiError extends Error {
  override readonly name = 'DrawingApiError'
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface DrawingsClientOptions {
  /** Defaults to the current origin, i.e. same-origin `/api`. */
  baseUrl?: string
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch
}

export interface DrawingsClient {
  list(query?: DrawingListQuery): Promise<DrawingList>
  get(id: string): Promise<Drawing>
  create(input: DrawingInput): Promise<Drawing>
  update(id: string, patch: DrawingPatch): Promise<Drawing>
  remove(id: string): Promise<void>
  stats(): Promise<DrawingStats>
  /**
   * Publish the drawing's original file and return the updated register entry
   * (whose `share` field now describes the link).
   *
   * This is the only call in the client that uploads drawing *content*; it is
   * always the direct result of a user choosing to share. Uploading again
   * replaces the previous file and token.
   */
  share(id: string, file: File, input?: ShareInput): Promise<Drawing>
  /** Revoke the link and delete the stored file. No-op if not shared. */
  unshare(id: string): Promise<Drawing>
}

/** Where a share link normally lives in the app's routes. */
export function sharePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`
}

/** Absolute, copy-pasteable share URL. */
export function shareUrl(token: string, origin?: string): string {
  const base = origin ?? currentOrigin()
  return `${base.replace(/\/$/, '')}${sharePath(token)}`
}

/**
 * `location.origin` when there is a document, `''` otherwise (tests, Worker).
 *
 * Read through a cast rather than the DOM global: this package is compiled by
 * the Worker's TypeScript project too, which has no DOM lib.
 */
function currentOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? ''
}

export function createDrawingsClient(options: DrawingsClientOptions = {}): DrawingsClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  /**
   * One fetch wrapper for both JSON and binary bodies. Errors are normalised to
   * {@link DrawingApiError} so the UI can show the server's message verbatim.
   */
  async function send<T>(
    path: string,
    init: RequestInit = {},
    offlinePrefix = '无法连接图纸库服务'
  ): Promise<T> {
    let response: Response
    try {
      response = await doFetch(`${baseUrl}/api${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...init.headers
        }
      })
    } catch (error) {
      // Offline / DNS / CORS: give the UI something actionable.
      throw new DrawingApiError(
        0,
        `${offlinePrefix}：${error instanceof Error ? error.message : String(error)}`
      )
    }
    return parseResponse<T>(response)
  }

  function request<T>(path: string, init?: RequestInit): Promise<T> {
    return send<T>(path, {
      ...init,
      headers: {
        // JSON is the default body type; binary uploads pass their own header.
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      }
    })
  }

  function toQueryString(query: DrawingListQuery): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      params.set(key, String(value))
    }
    const serialized = params.toString()
    return serialized.length > 0 ? `?${serialized}` : ''
  }

  return {
    list: query => request<DrawingList>(`/drawings${toQueryString(query ?? {})}`),

    get: async id => (await request<{ drawing: Drawing }>(`/drawings/${encodeURIComponent(id)}`)).drawing,

    create: async input =>
      (
        await request<{ drawing: Drawing }>('/drawings', {
          method: 'POST',
          body: JSON.stringify(input)
        })
      ).drawing,

    update: async (id, patch) =>
      (
        await request<{ drawing: Drawing }>(`/drawings/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch)
        })
      ).drawing,

    remove: async id => {
      await request<{ deleted: boolean }>(`/drawings/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
    },

    stats: () => request<DrawingStats>('/stats'),

    share: async (id, file, input) => {
      const params = new URLSearchParams()
      if (input?.expiresInDays !== undefined && input.expiresInDays !== null) {
        params.set('days', String(input.expiresInDays))
      }
      const query = params.toString()
      return (
        await send<{ drawing: Drawing }>(
          `/drawings/${encodeURIComponent(id)}/share${query ? `?${query}` : ''}`,
          {
            method: 'POST',
            // The body is the original file itself. `file.type` is often empty
            // for `.dwg`, so fall back to a generic binary type; the Worker
            // derives the authoritative type from the register's `format`.
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file
          },
          '无法连接图纸库服务'
        )
      ).drawing
    },

    unshare: async id =>
      (
        await request<{ drawing: Drawing }>(`/drawings/${encodeURIComponent(id)}/share`, {
          method: 'DELETE'
        })
      ).drawing
  }
}

/** The register fields a public share page is allowed to read. */
export interface PublicShareDrawing {
  name: string
  cadVersion: string | null
  entityCount: number
  layerCount: number
  layerNames: string[]
  entityTypes: Record<string, number>
  notes: string | null
  updatedAt: string
}

export interface PublicShare {
  share: DrawingShare
  /** The register entry, for the header. `null` if it was since deleted. */
  drawing: PublicShareDrawing | null
}

/**
 * Read-only access to a shared drawing, used by the public `/s/<token>` page.
 *
 * Separate from {@link DrawingsClient} on purpose: the share page must not be
 * able to list, edit or delete anything.
 */
export interface SharesClient {
  get(token: string): Promise<PublicShare>
  /** URL the viewer and the download button fetch the bytes from. */
  contentUrl(token: string, options?: { download?: boolean }): string
}

export function createSharesClient(options: DrawingsClientOptions = {}): SharesClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  return {
    get: async token => {
      let response: Response
      try {
        response = await doFetch(`${baseUrl}/api/shares/${encodeURIComponent(token)}`, {
          headers: { accept: 'application/json' }
        })
      } catch (error) {
        throw new DrawingApiError(
          0,
          `无法连接分享服务：${error instanceof Error ? error.message : String(error)}`
        )
      }
      return parseResponse<PublicShare>(response)
    },

    contentUrl: (token, contentOptions) =>
      `${baseUrl}/api/shares/${encodeURIComponent(token)}/content${
        contentOptions?.download ? '?download=1' : ''
      }`
  }
}

/** Shared response handling: non-2xx becomes a `DrawingApiError`. */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const payload = text.length > 0 ? safeParse(text) : undefined

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : undefined) ?? `请求失败（HTTP ${response.status}）`
    throw new DrawingApiError(response.status, message)
  }

  return payload as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A proxy or error page returned non-JSON; the status code still carries
    // the useful information.
    return undefined
  }
}
