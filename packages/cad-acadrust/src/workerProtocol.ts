/**
 * Message protocol between {@link AcadrustDwgParserWorker} (main thread) and
 * `dwgParserWorker.ts` (worker).
 *
 * Kept in its own module so both sides share one definition and the compiler
 * catches a protocol change on either end.
 */

export type AcadrustWorkerOperation =
  | 'dwgToDxf'
  | 'dxfToDwg'
  | 'dwgToDwg'
  | 'dxfToDxf'
  | 'inspect'

export interface AcadrustWorkerRequest {
  /** Monotonic request id, echoed back on the response. */
  id: number
  operation: AcadrustWorkerOperation
  /** Input drawing. Transferred, so the sender's view is detached. */
  buffer: ArrayBuffer
  /** Target version code (`0` = keep the source version). */
  versionCode: number
  /** Only meaningful for the `inspect` operation: is the input a DWG? */
  isDwg?: boolean
  /**
   * Where the worker should load the wasm glue from. Sent per request because
   * a worker instantiated from a bundled asset resolves `import.meta.url`
   * differently from the page.
   */
  glueUrl?: string
  wasmUrl?: string
}

export type AcadrustWorkerResponse =
  | { id: number; ok: true; buffer: ArrayBuffer }
  | { id: number; ok: false; error: string }

/** Default ceiling for a single worker conversion. */
export const ACADRUSTR_WORKER_TIMEOUT_MS = 120_000
