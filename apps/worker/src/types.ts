/**
 * Worker bindings.
 *
 * The API's data types live in `@onlinecad/api-contract` so the Worker and the
 * browser app are compiled against one definition.
 */

export interface Env {
  /** Static assets binding for the built SPA (`apps/web/dist`). */
  ASSETS: Fetcher
  /** D1 database holding the drawing index. */
  DB: D1Database
  /**
   * R2 bucket holding the *original* file of drawings the user chose to share.
   * It is empty for drawings that were never shared.
   */
  BUCKET: R2Bucket
}
