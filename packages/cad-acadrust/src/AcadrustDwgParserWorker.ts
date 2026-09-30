/**
 * Main-thread bridge to `dwgParserWorker.ts`.
 *
 * Owns request/response correlation, transferables, timeouts and worker
 * recycling. The converter talks to this class rather than to a raw `Worker`
 * so that a hung or crashed worker degrades into one failed conversion instead
 * of breaking every later one.
 */

import type { DrawingSummary } from './wasm'
import {
  ACADRUSTR_WORKER_TIMEOUT_MS,
  type AcadrustWorkerOperation,
  type AcadrustWorkerRequest,
  type AcadrustWorkerResponse
} from './workerProtocol'

interface PendingRequest {
  resolve: (buffer: ArrayBuffer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  operation: AcadrustWorkerOperation
}

/**
 * Raised when the worker itself is unusable — crashed, terminated or timed out
 * — as opposed to the drawing failing to parse. Only this kind of failure
 * justifies throwing the worker away.
 */
export class AcadrustWorkerUnavailableError extends Error {
  override readonly name = 'AcadrustWorkerUnavailableError'
}

export interface AcadrustDwgParserWorkerOptions {
  glueUrl?: string
  wasmUrl?: string
  /** Per-request ceiling. Defaults to {@link ACADRUSTR_WORKER_TIMEOUT_MS}. */
  timeoutMs?: number
}

export class AcadrustDwgParserWorker {
  readonly #worker: Worker
  readonly #options: AcadrustDwgParserWorkerOptions
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 1
  #disposed = false

  constructor(worker: Worker, options: AcadrustDwgParserWorkerOptions = {}) {
    this.#worker = worker
    this.#options = options
    this.#worker.addEventListener('message', this.#onMessage)
    this.#worker.addEventListener('error', this.#onError)
  }

  /** DWG → DXF. */
  dwgToDxf(data: Uint8Array, versionCode = 0): Promise<Uint8Array> {
    return this.#request('dwgToDxf', data, versionCode)
  }

  /** DXF → DWG. */
  dxfToDwg(data: Uint8Array, versionCode = 0): Promise<Uint8Array> {
    return this.#request('dxfToDwg', data, versionCode)
  }

  /** DWG → DWG. */
  dwgToDwg(data: Uint8Array, versionCode = 0): Promise<Uint8Array> {
    return this.#request('dwgToDwg', data, versionCode)
  }

  /** DXF → DXF. */
  dxfToDxf(data: Uint8Array, versionCode = 0): Promise<Uint8Array> {
    return this.#request('dxfToDxf', data, versionCode)
  }

  /** Parse a drawing and return its metadata summary. */
  async inspect(data: Uint8Array, isDwg: boolean): Promise<DrawingSummary> {
    const buffer = await this.#request('inspect', data, 0, isDwg)
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))) as DrawingSummary
  }

  /** Tear down the worker and fail anything still in flight. */
  terminate(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#worker.removeEventListener('message', this.#onMessage)
    this.#worker.removeEventListener('error', this.#onError)
    this.#worker.terminate()
    this.#failAll(new AcadrustWorkerUnavailableError('The DWG parser worker was terminated.'))
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** True when `error` means the worker must be replaced, not just the file rejected. */
  static isUnavailable(error: unknown): boolean {
    return error instanceof AcadrustWorkerUnavailableError
  }

  readonly #onMessage = (event: MessageEvent<AcadrustWorkerResponse>): void => {
    const response = event.data
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    clearTimeout(pending.timer)

    if (response.ok) {
      pending.resolve(response.buffer)
    } else {
      // Include the operation: a bare "DWG parse failed" is hard to place when
      // several conversions are in flight.
      pending.reject(new Error(`${pending.operation}: ${response.error}`))
    }
  }

  readonly #onError = (event: ErrorEvent): void => {
    this.#failAll(
      new AcadrustWorkerUnavailableError(
        `The DWG parser worker crashed: ${event.message}`
      )
    )
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #request(
    operation: AcadrustWorkerOperation,
    data: Uint8Array,
    versionCode: number,
    isDwg?: boolean
  ): Promise<Uint8Array> {
    if (this.#disposed) {
      return Promise.reject(
        new AcadrustWorkerUnavailableError('The DWG parser worker has been terminated.')
      )
    }

    const id = this.#nextId++
    // Copy so transferring does not detach the caller's view.
    const buffer = data.slice().buffer

    return new Promise<Uint8Array>((resolve, reject) => {
      const timeoutMs = this.#options.timeoutMs ?? ACADRUSTR_WORKER_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new AcadrustWorkerUnavailableError(
            `${operation} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
              `The drawing may be too large or damaged.`
          )
        )
      }, timeoutMs)

      this.#pending.set(id, {
        resolve: output => resolve(new Uint8Array(output)),
        reject,
        timer,
        operation
      })

      const request: AcadrustWorkerRequest = {
        id,
        operation,
        buffer,
        versionCode,
        isDwg,
        glueUrl: this.#options.glueUrl,
        wasmUrl: this.#options.wasmUrl
      }
      this.#worker.postMessage(request, [buffer])
    })
  }
}

/**
 * Create a module worker that runs the acadrust engine.
 *
 * The `new URL(..., import.meta.url)` form is what lets Vite (and any bundler)
 * statically discover, bundle and fingerprint the worker while still letting
 * Cloudflare Workers serve it as a plain static asset.
 */
export function createAcadrustDwgParserWorker(): Worker {
  return new Worker(new URL('./dwgParserWorker.ts', import.meta.url), {
    type: 'module',
    name: 'acadrust-dwg-parser'
  })
}
