/**
 * Web Worker entry point.
 *
 * DWG parsing is CPU-bound and can take seconds on a large drawing, so the
 * converter runs it here whenever the host supplies a worker factory. The
 * worker keeps its own {@link AcadrustWasm} instance, which means a conversion
 * never touches the main thread's engine (and vice versa).
 *
 * Build note: Vite bundles this as a module worker via
 * `new Worker(new URL('./dwgParserWorker.ts', import.meta.url), { type: 'module' })`
 * in `AcadrustDwgParserWorker.ts`.
 */

import { AcadrustWasm } from './wasm'
import type {
  AcadrustWorkerRequest,
  AcadrustWorkerResponse
} from './workerProtocol'

/**
 * Structural view of the worker global scope.
 *
 * Declared structurally rather than via `/// <reference lib="webworker" />`
 * because that lib cannot coexist with `lib.dom` in one tsconfig (duplicate
 * global declarations).
 */
interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AcadrustWorkerRequest>) => void
  ): void
  postMessage(message: AcadrustWorkerResponse, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope

let engine: Promise<AcadrustWasm> | undefined

/** Lazily instantiate, and re-instantiate after a trap poisons the instance. */
async function getEngine(request: AcadrustWorkerRequest): Promise<AcadrustWasm> {
  if (!engine) {
    engine = AcadrustWasm.instantiate({
      glueUrl: request.glueUrl,
      wasmUrl: request.wasmUrl
    }).catch(error => {
      engine = undefined
      throw error
    })
  }
  return engine
}

function resetEngine(): void {
  engine = undefined
}

scope.addEventListener('message', event => {
  void handle(event.data)
})

async function handle(request: AcadrustWorkerRequest): Promise<void> {
  const { id, operation, buffer, versionCode } = request
  try {
    const wasm = await getEngine(request)
    const input = new Uint8Array(buffer)

    let result: Uint8Array
    switch (operation) {
      case 'dwgToDxf':
        result = wasm.dwgToDxf(input, versionCode)
        break
      case 'dxfToDwg':
        result = wasm.dxfToDwg(input, versionCode)
        break
      case 'dwgToDwg':
        result = wasm.dwgToDwg(input, versionCode)
        break
      case 'dxfToDxf':
        result = wasm.dxfToDxf(input, versionCode)
        break
      case 'inspect':
        result = new TextEncoder().encode(
          JSON.stringify(wasm.inspect(input, request.isDwg === true))
        )
        break
    }

    // Copy out of wasm memory before transferring: the engine may reuse that
    // memory on the next call.
    const output = result.slice().buffer
    scope.postMessage({ id, ok: true, buffer: output }, [output])
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      // `panic = "abort"` leaves the instance unusable.
      resetEngine()
    }
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
