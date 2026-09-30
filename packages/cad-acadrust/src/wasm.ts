/**
 * Loader for the `acadrust-wasm` module.
 *
 * The artifact is the pair `acadrust_wasm.js` (wasm-bindgen's ESM glue) +
 * `acadrust_wasm_bg.wasm`, produced by `scripts/build-wasm.sh` into
 * `packages/cad-acadrust/wasm/` and served from the app's `/wasm/` directory.
 *
 * Two things here are load-bearing beyond "call the exported functions":
 *
 * 1. **Instance recycling.** The crate is built with `panic = "abort"`, so a
 *    Rust panic traps the instance and every later call into it would fail with
 *    `RuntimeError: unreachable`. Files are user-supplied, so instead of
 *    treating a trap as fatal we drop the poisoned instance and lazily
 *    instantiate a fresh one on the next call.
 *
 * 2. **Lazy loading.** Nothing is fetched until the first conversion, so the
 *    ~1 MB wasm is not on the critical path for users who only ever open DXF.
 */

/** Result of {@link AcadrustWasm.inspect}. Metadata only — never geometry. */
export interface DrawingSummary {
  format: 'dwg' | 'dxf'
  /** DXF version code of the source, e.g. `AC1032`. */
  version: string
  entityCount: number
  modelSpaceEntityCount: number
  layerCount: number
  layerNames: string[]
  /** True when the drawing has more layers than {@link AcadrustWasm} reports. */
  layerNamesTruncated: boolean
  /** Entity count per DXF entity type, highest first. */
  entityTypes: Record<string, number>
  entityTypeCount: number
  /**
   * True when the parser had to recover from damage, i.e. the file opened but
   * some records could not be read. Worth surfacing in the UI: a partially
   * recovered drawing can silently look wrong.
   */
  recovered: boolean
  /** Number of problems the parser reported while reading. */
  diagnostics: number
}

export interface AcadrustWasmOptions {
  /**
   * URL of wasm-bindgen's ESM glue. Defaults to `/wasm/acadrust_wasm.js`, which
   * is where the web app copies the build output.
   */
  glueUrl?: string | URL
  /**
   * URL of the `.wasm` binary. Defaults to the glue's sibling
   * `acadrust_wasm_bg.wasm`.
   *
   * Ignored when {@link AcadrustWasmOptions.wasmModule} is set.
   */
  wasmUrl?: string | URL
  /**
   * Pre-loaded wasm bytes or a compiled `WebAssembly.Module`, skipping the
   * network entirely. Used by the Node test suite and by hosts that embed the
   * artifact in their own bundle.
   */
  wasmModule?: BufferSource | WebAssembly.Module
}

/** The subset of wasm-bindgen's generated module surface this loader uses. */
interface AcadrustGlue {
  abiVersion(): number
  acadrustVersion(): string
  convert(
    data: Uint8Array,
    fromDwg: boolean,
    toDwg: boolean,
    versionCode: number
  ): Uint8Array
  dwgToDxf(data: Uint8Array, versionCode: number): Uint8Array
  dxfToDwg(data: Uint8Array, versionCode: number): Uint8Array
  dwgToDwg(data: Uint8Array, versionCode: number): Uint8Array
  dxfToDxf(data: Uint8Array, versionCode: number): Uint8Array
  inspect(data: Uint8Array, isDwg: boolean): string
  default(input?: unknown): Promise<unknown>
}

/** Must match `ABI_VERSION` in `crates/acadrust-wasm/src/lib.rs`. */
export const EXPECTED_ABI_VERSION = 1

export const DEFAULT_GLUE_URL = '/wasm/acadrust_wasm.js'
export const DEFAULT_WASM_URL = '/wasm/acadrust_wasm_bg.wasm'

/**
 * A WebAssembly trap. `panic = "abort"` surfaces as `RuntimeError:
 * unreachable`; out-of-bounds access surfaces as `RuntimeError: memory access
 * out of bounds`.
 */
function isTrapError(error: unknown): boolean {
  return error instanceof WebAssembly.RuntimeError
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

/**
 * Return an `ArrayBuffer` that is exactly the given bytes. A `Uint8Array` view
 * that covers its whole buffer can be passed through; anything else is copied,
 * since the viewer hands the buffer to a converter that may retain it.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

/**
 * A loaded acadrust engine.
 *
 * All methods are synchronous once loaded: the wasm-bindgen glue is a plain
 * function call, and callers that need to stay off the main thread should use
 * {@link AcadrustDwgParserWorker} instead.
 */
export class AcadrustWasm {
  readonly #glue: AcadrustGlue
  readonly #abiVersion: number
  readonly #acadrustVersion: string
  readonly #options: AcadrustWasmOptions

  private constructor(
    glue: AcadrustGlue,
    options: AcadrustWasmOptions,
    abiVersion: number,
    acadrustVersion: string
  ) {
    this.#glue = glue
    this.#options = options
    this.#abiVersion = abiVersion
    this.#acadrustVersion = acadrustVersion
  }

  /**
   * Instantiate the module. Safe to call repeatedly; each call re-instantiated
   * its own copy, so callers usually want {@link loadAcadrustWasm} instead.
   */
  static async instantiate(options: AcadrustWasmOptions = {}): Promise<AcadrustWasm> {
    const glueUrl = String(options.glueUrl ?? DEFAULT_GLUE_URL)
    // Passing bytes/module avoids the fetch; passing a URL string lets
    // wasm-bindgen's glue fetch it, which is the browser path.
    const moduleOrPath: unknown =
      options.wasmModule ?? String(options.wasmUrl ?? DEFAULT_WASM_URL)

    // A runtime URL keeps the glue out of the bundle graph entirely: the app
    // serves it as a static asset, which is also what Cloudflare Workers does.
    const glue = (await import(/* @vite-ignore */ glueUrl)) as unknown as AcadrustGlue
    await glue.default({ module_or_path: moduleOrPath })

    const abiVersion = glue.abiVersion()
    if (abiVersion !== EXPECTED_ABI_VERSION) {
      throw new Error(
        `acadrust-wasm ABI mismatch: artifact reports ${abiVersion}, ` +
          `this build expects ${EXPECTED_ABI_VERSION}. Run \`npm run build:wasm\`.`
      )
    }

    return new AcadrustWasm(glue, options, abiVersion, glue.acadrustVersion())
  }

  get abiVersion(): number {
    return this.#abiVersion
  }

  /** Bundled `acadrust` crate version, for the app's About panel. */
  get acadrustVersion(): string {
    return this.#acadrustVersion
  }

  get options(): AcadrustWasmOptions {
    return this.#options
  }

  /** DWG → DXF. The path used when opening a `.dwg`. */
  dwgToDxf(data: Uint8Array | ArrayBuffer, versionCode = 0): Uint8Array {
    return this.#glue.dwgToDxf(toBytes(data), versionCode)
  }

  /** DXF → DWG, for "export as DWG" after local edits. */
  dxfToDwg(data: Uint8Array | ArrayBuffer, versionCode = 0): Uint8Array {
    return this.#glue.dxfToDwg(toBytes(data), versionCode)
  }

  /** DWG → DWG, e.g. to downgrade the file version. */
  dwgToDwg(data: Uint8Array | ArrayBuffer, versionCode = 0): Uint8Array {
    return this.#glue.dwgToDwg(toBytes(data), versionCode)
  }

  /** DXF → DXF, i.e. normalize or re-version a DXF. */
  dxfToDxf(data: Uint8Array | ArrayBuffer, versionCode = 0): Uint8Array {
    return this.#glue.dxfToDxf(toBytes(data), versionCode)
  }

  /**
   * Parse a drawing and return its metadata summary, without going through the
   * renderer. Used to index an upload before/while the viewer opens it.
   */
  inspect(data: Uint8Array | ArrayBuffer, isDwg: boolean): DrawingSummary {
    return JSON.parse(this.#glue.inspect(toBytes(data), isDwg)) as DrawingSummary
  }
}

/** One engine promise per glue/wasm URL pair. */
const instances = new Map<string, Promise<AcadrustWasm>>()

/**
 * Cache key for a loader configuration. Returns `null` for inline wasm
 * (see {@link AcadrustWasmOptions.wasmModule}) so callers that supply their own
 * module always get an independent, trap-isolated instance.
 */
function cacheKey(options: AcadrustWasmOptions): string | null {
  if (options.wasmModule) return null
  return `${options.glueUrl ?? DEFAULT_GLUE_URL}|${options.wasmUrl ?? DEFAULT_WASM_URL}`
}

/**
 * Cached factory. Typically you want one engine per JS realm (window or
 * worker), so this memoises by glue URL and re-instantiates after a trap.
 *
 * The returned engine is wrapped so a {@link WebAssembly.RuntimeError} drops
 * the cached instance, letting the next caller retry on a clean one.
 */
export function loadAcadrustWasm(options: AcadrustWasmOptions = {}): Promise<AcadrustWasm> {
  const key = cacheKey(options)
  if (key === null) return AcadrustWasm.instantiate(options)

  const existing = instances.get(key)
  if (existing) return existing

  const pending = AcadrustWasm.instantiate(options).catch(error => {
    // Never cache a failed load; otherwise one transient fetch error would
    // permanently break the session.
    instances.delete(key)
    throw error
  })
  instances.set(key, pending)
  return pending
}

/**
 * Run `operation` against the shared engine, recycling the instance if the
 * operation traps.
 */
export async function withAcadrustWasm<T>(
  operation: (wasm: AcadrustWasm) => T,
  options: AcadrustWasmOptions = {}
): Promise<T> {
  const wasm = await loadAcadrustWasm(options)
  try {
    return operation(wasm)
  } catch (error) {
    if (isTrapError(error)) {
      // The instance is now unusable (`panic = "abort"`); drop it so the next
      // call gets a fresh one and can still report a real error to the user.
      const key = cacheKey(options)
      if (key !== null) instances.delete(key)
      throw new Error(
        `The DWG engine hit an internal error while processing this file. ` +
          `The engine has been reset; retrying may work. (${String(error)})`
      )
    }
    throw error
  }
}
