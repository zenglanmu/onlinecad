/**
 * The app's single handle on the acadrust engine.
 *
 * This module is side-effectful on purpose: importing it registers acadrust as
 * cad-viewer's DWG converter, which must happen **before** the viewer opens any
 * document. `src/main.ts` imports it before mounting the app, so registration
 * can never be raced by a file open.
 *
 * The same engine instance is exported for the app's own needs (indexing a file
 * into the D1 register, exporting DWG), so an open + save + export share one
 * worker instead of spawning one per feature.
 */

import { createAcadrustDwgParserWorker, registerAcadrustDwgConverter } from '@onlinecad/cad-acadrust'

export const acadrustConverter = registerAcadrustDwgConverter({
  // Run DWG → DXF in a Web Worker: a 50 MB drawing must not freeze the UI.
  createWorker: createAcadrustDwgParserWorker,
  // Keep each drawing's own version on open; exports pin a version explicitly.
  targetVersion: 0
})

export const acadrustEngine = acadrustConverter.engine
