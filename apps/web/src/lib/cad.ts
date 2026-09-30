/**
 * The app's lazily-loaded CAD stack.
 *
 * Nothing here imports the viewer, the acadrust wasm glue or the DWG parser
 * worker statically: every one of those is fetched on the **first drawing
 * open**, not when the start-up page (welcome screen / drawing register) loads.
 * That keeps the welcome screen cheap and means a visitor who never opens a
 * drawing never downloads the ~1 MB engine or the THREE-based viewer.
 *
 * Two ordering rules make this safe:
 *
 * 1. acadrust must be registered as cad-viewer's DWG converter *before* the
 *    viewer opens a document, so callers `await {@link loadCadRuntime}` and only
 *    then hand the file to `MlCadViewer`.
 * 2. cad-viewer's components resolve their strings through the global vue-i18n
 *    plugin, so {@link loadCadRuntime} installs `i18n` on the app at the same
 *    time it returns the viewer component. Callers therefore only render the
 *    viewer after the runtime has resolved.
 */

import type { DrawingSummary } from '@onlinecad/cad-acadrust'
import type { App, Component } from 'vue'

/**
 * The slice of the acadrust engine the app uses, typed structurally.
 *
 * Taking the class type directly from the lazily `import()`ed module is not
 * possible here: the engine class has ECMAScript private fields, so the copy
 * resolved by `import()` and any separately-resolved copy are nominally
 * distinct and would not be assignable. Describing the public surface avoids
 * that and keeps `cad.ts` decoupled from the engine's implementation.
 */
export interface AcadrustEngine {
  inspect(data: Uint8Array, isDwg: boolean): Promise<DrawingSummary>
  dxfToDwg(data: Uint8Array, versionCode?: number): Promise<Uint8Array>
}

/** Everything the app needs from the CAD stack, resolved in one shot. */
export interface CadRuntime {
  /** `@mlightcad/cad-viewer`'s viewer component. */
  MlCadViewer: Component
  /** Document manager, used by the DWG export path. */
  AcApDocManager: typeof import('@mlightcad/cad-simple-viewer').AcApDocManager
  /** `AcEdOpenMode` enum, passed to the viewer as a prop. */
  AcEdOpenMode: typeof import('@mlightcad/cad-simple-viewer').AcEdOpenMode
  /** AutoCAD 2018 version code for DWG export. */
  DXF_VERSION_AC1032: number
  /** The shared acadrust engine (metadata + DWG export). */
  engine: AcadrustEngine
}

/** The Vue app, needed to install cad-viewer's i18n plugin. Set by `main.ts`. */
let app: App | null = null

/** Called once from `main.ts` before mount; keeps `loadCadRuntime` arg-free. */
export function bindCadApp(instance: App): void {
  app = instance
}

let runtime: Promise<CadRuntime> | null = null

/**
 * Dynamically import and wire up the CAD stack. Cached, so the viewer and
 * engine are instantiated exactly once per page load no matter how many callers
 * race the first open.
 */
export function loadCadRuntime(): Promise<CadRuntime> {
  if (!app) {
    return Promise.reject(new Error('CAD runtime requested before the app was bound.'))
  }
  runtime ??= createRuntime(app)
  return runtime
}

async function createRuntime(instance: App): Promise<CadRuntime> {
  // Import in parallel: these three graphs are independent and all needed.
  const [viewer, simpleViewer, acadrust] = await Promise.all([
    import('@mlightcad/cad-viewer'),
    import('@mlightcad/cad-simple-viewer'),
    import('@onlinecad/cad-acadrust')
  ])

  // Registered here (not at module scope) so the engine only exists once a
  // drawing is actually being opened.
  instance.use(viewer.i18n)

  const converter = acadrust.registerAcadrustDwgConverter({
    // DWG → DXF runs in a worker; a 50 MB drawing must not freeze the UI.
    createWorker: acadrust.createAcadrustDwgParserWorker,
    // Keep each drawing's own version on open; exports pin a version explicitly.
    targetVersion: 0
  })

  return {
    MlCadViewer: viewer.MlCadViewer,
    AcApDocManager: simpleViewer.AcApDocManager,
    AcEdOpenMode: simpleViewer.AcEdOpenMode,
    DXF_VERSION_AC1032: acadrust.DXF_VERSION_AC1032,
    engine: converter.engine
  }
}
