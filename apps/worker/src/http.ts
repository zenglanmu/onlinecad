/** Small HTTP helpers shared by the route handlers. */

/** An error that should be rendered as a specific HTTP status. */
export class HttpError extends Error {
  override readonly name = 'HttpError'
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>
  ) {
    super(message)
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  // Metadata responses are cheap to recompute and must never be cached at the
  // edge, otherwise a delete would appear to succeed while still being listed.
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function methodNotAllowed(allowed: string[], actual: string): HttpError {
  return new HttpError(405, `Method ${actual} is not supported here.`, {
    allow: allowed.join(', ')
  })
}
