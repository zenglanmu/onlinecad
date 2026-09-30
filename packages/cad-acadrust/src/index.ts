/**
 * @onlinecad/cad-acadrust
 *
 * acadrust (Rust → WebAssembly) as a drop-in DWG engine for
 * `@mlightcad/cad-viewer`.
 *
 * ```ts
 * import { registerAcadrustDwgConverter } from '@onlinecad/cad-acadrust'
 *
 * registerAcadrustDwgConverter({ createWorker: createAcadrustDwgParserWorker })
 * ```
 */

export {
  AcadrustWasm,
  loadAcadrustWasm,
  withAcadrustWasm,
  toArrayBuffer,
  DEFAULT_GLUE_URL,
  DEFAULT_WASM_URL,
  EXPECTED_ABI_VERSION,
  type AcadrustWasmOptions,
  type DrawingSummary
} from './wasm'

export {
  AcadrustDwgEngine,
  DXF_VERSION_AC1032,
  type AcadrustDwgEngineOptions
} from './AcadrustDwgEngine'

export {
  AcadrustDwgParserWorker,
  AcadrustWorkerUnavailableError,
  createAcadrustDwgParserWorker,
  type AcadrustDwgParserWorkerOptions
} from './AcadrustDwgParserWorker'

export {
  AcDbAcadrustDwgConverter,
  registerAcadrustDwgConverter,
  type AcadrustDwgConverterOptions
} from './AcDbAcadrustDwgConverter'

export type {
  AcadrustWorkerOperation,
  AcadrustWorkerRequest,
  AcadrustWorkerResponse
} from './workerProtocol'
