/**
 * Registers acadrust as cad-viewer's DWG engine.
 *
 * ## Why this exists
 *
 * `@mlightcad/cad-simple-viewer` deliberately ships **no** DWG converter: hosts
 * opt in. The two upstream options are
 * [`@mlightcad/libredwg-converter`](https://www.npmjs.com/package/@mlightcad/libredwg-converter)
 * (GPL-3.0, and capped by the LibreDWG WASM heap) or a commercial closed-source
 * parser sold separately. acadrust is MPL-2.0, pure Rust, and both reads *and
 * writes* DWG R13 → R2018+, so it also makes "edit locally, export a real
 * `.dwg`" possible.
 *
 * ## How the hand-off works
 *
 * `@mlightcad/data-model` already owns the drawing → scene pipeline (layers,
 * linetypes, blocks, proxy graphics, progressive rendering). Rather than
 * reimplement it, this converter converts DWG → DXF bytes in wasm and then
 * delegates to the same `AcDbNativeDxfConverter` the viewer uses for `.dxf`
 * files. One code path turns bytes into a database, whatever the input was.
 *
 * Progress is remapped so the DWG→DXF step owns 0–25% and the shared DXF
 * pipeline owns 25–100%, which keeps the viewer's progress bar monotonic.
 */

import {
  AcDbDatabaseConverter,
  AcDbDatabaseConverterManager,
  AcDbFileType,
  AcDbNativeDxfConverter,
  type AcDbConversionProgressCallback,
  type AcDbConversionStage,
  type AcDbDatabase,
  type AcDbDatabaseConverterReadOptions,
  type AcDbStageStatus
} from '@mlightcad/data-model'

import { AcadrustDwgEngine, type AcadrustDwgEngineOptions } from './AcadrustDwgEngine'
import { toArrayBuffer } from './wasm'

/** Share of the progress bar owned by the DWG → DXF conversion. */
const DWG_STAGE_SHARE = 25

export interface AcadrustDwgConverterOptions extends AcadrustDwgEngineOptions {}

/**
 * `AcDbFileType.DWG` converter backed by acadrust.
 *
 * Register it before the viewer opens a document:
 *
 * ```ts
 * registerAcadrustDwgConverter({ createWorker: createAcadrustDwgParserWorker })
 * ```
 */
export class AcDbAcadrustDwgConverter extends AcDbDatabaseConverter<null> {
  readonly #engine: AcadrustDwgEngine
  readonly #dxfConverter: AcDbNativeDxfConverter

  constructor(options: AcadrustDwgConverterOptions = {}) {
    // `useWorker: false` describes *this* converter: the heavy lifting happens
    // in `AcadrustDwgEngine`, which owns its own worker.
    super({ useWorker: false, convertByEntityType: false })
    this.#engine = new AcadrustDwgEngine(options)
    this.#dxfConverter = new AcDbNativeDxfConverter({
      useWorker: false,
      convertByEntityType: false
    })
  }

  /** The underlying engine, e.g. for `dxfToDwg` export or `inspect`. */
  get engine(): AcadrustDwgEngine {
    return this.#engine
  }

  /**
   * Open a DWG: convert to DXF with acadrust, then let the data-model's native
   * DXF converter build the `AcDbDatabase`.
   */
  override async read(
    data: ArrayBuffer,
    db: AcDbDatabase,
    options?: AcDbDatabaseConverterReadOptions
  ): Promise<void> {
    const progress = options?.progress ?? this.progress
    await progress?.(0, 'START', 'START')
    await progress?.(1, 'PARSE', 'IN-PROGRESS')

    const dxf = await this.#engine.dwgToDxf(new Uint8Array(data))

    await progress?.(DWG_STAGE_SHARE, 'PARSE', 'END')

    await this.#dxfConverter.read(toArrayBuffer(dxf), db, {
      ...options,
      progress: progress ? scaleProgress(progress) : undefined
    })
  }

  /** Release the parsing worker. Safe to call more than once. */
  dispose(): void {
    this.#engine.dispose()
  }
}

/**
 * Shift a child callback's 0–100 range into {@link DWG_STAGE_SHARE}–100 so the
 * bar reflects the DWG→DXF step that already happened.
 */
function scaleProgress(
  outer: AcDbConversionProgressCallback
): AcDbConversionProgressCallback {
  return (
    percentage: number,
    stage: AcDbConversionStage,
    status: AcDbStageStatus,
    data?: unknown,
    error?: Parameters<AcDbConversionProgressCallback>[4]
  ) => {
    const scaled =
      DWG_STAGE_SHARE +
      Math.round((clampPercent(percentage) / 100) * (100 - DWG_STAGE_SHARE))
    return outer(scaled, stage, status, data, error)
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Register acadrust as the DWG converter for cad-viewer.
 *
 * Replaces any previously registered DWG converter, so calling it twice (e.g.
 * from a hot-reload) is harmless.
 */
export function registerAcadrustDwgConverter(
  options: AcadrustDwgConverterOptions = {}
): AcDbAcadrustDwgConverter {
  const converter = new AcDbAcadrustDwgConverter(options)
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, converter)
  return converter
}
