/**
 * `AcadrustDwgEngine` — the app-facing facade over the acadrust wasm module.
 *
 * It hides the two execution strategies behind one API:
 *
 * * **worker** (preferred) — the host passes `createWorker`, and every
 *   conversion hops to a Web Worker so a 50 MB drawing cannot freeze the UI;
 * * **main thread** — no worker factory, or `forceMainThread`, which is what
 *   tests and non-DOM environments use.
 *
 * It also owns failure recovery: a worker that crashes, times out or traps is
 * terminated and lazily rebuilt on the next call, so one bad drawing never
 * poisons the session.
 */

import {
  AcadrustDwgParserWorker,
  createAcadrustDwgParserWorker
} from './AcadrustDwgParserWorker'
import { withAcadrustWasm, type DrawingSummary } from './wasm'

export interface AcadrustDwgEngineOptions {
  /**
   * Factory for the parsing worker, e.g. {@link createAcadrustDwgParserWorker}.
   * When omitted, conversions run on the calling thread.
   */
  createWorker?: () => Worker
  /** Run on the calling thread even when `createWorker` is supplied. */
  forceMainThread?: boolean
  /** Target version code, e.g. `1032` (AutoCAD 2018). `0` keeps the source version. */
  targetVersion?: number
  /** Where the wasm-bindgen glue lives. Defaults to `/wasm/acadrust_wasm.js`. */
  glueUrl?: string
  /** Where the `.wasm` binary lives. Defaults to the glue's sibling. */
  wasmUrl?: string
  /** Per-conversion ceiling for worker mode. */
  workerTimeoutMs?: number
}

/** Version code of AutoCAD 2018+, the newest format acadrust writes. */
export const DXF_VERSION_AC1032 = 1032

export class AcadrustDwgEngine {
  readonly #options: AcadrustDwgEngineOptions
  #worker?: AcadrustDwgParserWorker

  constructor(options: AcadrustDwgEngineOptions = {}) {
    this.#options = options
  }

  get targetVersion(): number {
    return this.#options.targetVersion ?? 0
  }

  /** True when conversions are dispatched to a Web Worker. */
  get usesWorker(): boolean {
    return !this.#options.forceMainThread && this.#options.createWorker !== undefined
  }

  /** DWG → DXF. The path used when opening a `.dwg`. */
  dwgToDxf(data: Uint8Array, versionCode = this.targetVersion): Promise<Uint8Array> {
    return this.#run('dwgToDxf', data, versionCode)
  }

  /** DXF → DWG, for "export as DWG" after local edits. */
  dxfToDwg(data: Uint8Array, versionCode = this.targetVersion): Promise<Uint8Array> {
    return this.#run('dxfToDwg', data, versionCode)
  }

  /** DWG → DWG through acadrust, e.g. to downgrade the file version. */
  dwgToDwg(data: Uint8Array, versionCode = this.targetVersion): Promise<Uint8Array> {
    return this.#run('dwgToDwg', data, versionCode)
  }

  /** DXF → DXF through acadrust, i.e. normalize or re-version a DXF. */
  dxfToDxf(data: Uint8Array, versionCode = this.targetVersion): Promise<Uint8Array> {
    return this.#run('dxfToDxf', data, versionCode)
  }

  /**
   * Parse a drawing and return its metadata summary without opening the
   * renderer. Used to index an upload in D1 before the viewer mounts.
   */
  async inspect(data: Uint8Array, isDwg: boolean): Promise<DrawingSummary> {
    const worker = this.#getWorker()
    if (worker) {
      try {
        return await worker.inspect(data, isDwg)
      } catch (error) {
        this.#handleWorkerFailure(error)
        throw error
      }
    }
    return withAcadrustWasm(wasm => wasm.inspect(data, isDwg), this.#wasmOptions())
  }

  /** Release the worker, if any. The engine stays usable afterwards. */
  dispose(): void {
    this.#worker?.terminate()
    this.#worker = undefined
  }

  #wasmOptions(): { glueUrl?: string; wasmUrl?: string } {
    return { glueUrl: this.#options.glueUrl, wasmUrl: this.#options.wasmUrl }
  }

  async #run(
    operation: 'dwgToDxf' | 'dxfToDwg' | 'dwgToDwg' | 'dxfToDxf',
    data: Uint8Array,
    versionCode: number
  ): Promise<Uint8Array> {
    const worker = this.#getWorker()
    if (worker) {
      try {
        return await worker[operation](data, versionCode)
      } catch (error) {
        this.#handleWorkerFailure(error)
        throw error
      }
    }
    return withAcadrustWasm(
      wasm => wasm[operation](data, versionCode),
      this.#wasmOptions()
    )
  }

  #getWorker(): AcadrustDwgParserWorker | undefined {
    if (!this.usesWorker) return undefined
    if (this.#worker && !this.#worker.disposed) return this.#worker

    const worker = new AcadrustDwgParserWorker(this.#options.createWorker!(), {
      glueUrl: this.#options.glueUrl,
      wasmUrl: this.#options.wasmUrl,
      timeoutMs: this.#options.workerTimeoutMs
    })
    this.#worker = worker
    return worker
  }

  /**
   * A crashed, timed-out or terminated worker is unusable; drop it so the next
   * call builds a fresh one. Ordinary parse errors leave the worker intact.
   */
  #handleWorkerFailure(error: unknown): void {
    if (AcadrustDwgParserWorker.isUnavailable(error) && this.#worker) {
      this.#worker.terminate()
      this.#worker = undefined
    }
  }
}
