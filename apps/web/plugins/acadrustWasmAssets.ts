import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * wasm-bindgen's `--target web` output: an ESM glue module plus its sibling
 * `.wasm`. Both must be served as plain static assets, because the app loads
 * the glue with a runtime `import('/wasm/acadrust_wasm.js')` rather than
 * bundling it (that is also how Cloudflare Workers serves it).
 */
export const WASM_ASSET_FILES = ['acadrust_wasm.js', 'acadrust_wasm_bg.wasm'] as const

const CONTENT_TYPES: Record<string, string> = {
  'acadrust_wasm.js': 'text/javascript; charset=utf-8',
  // Required for `WebAssembly.instantiateStreaming`; without it the browser
  // falls back to a slower path and logs a warning.
  'acadrust_wasm_bg.wasm': 'application/wasm'
}

/**
 * Serves `/wasm/*` from the `@onlinecad/cad-acadrust` build output, in dev and
 * in production, without copying the ~5 MB artifact into `public/`.
 *
 * Failing loudly when the artifact is missing is intentional: a stale or absent
 * wasm would otherwise surface as a confusing 404 in the middle of opening a
 * drawing.
 */
export function acadrustWasmAssets(sourceDir: string): Plugin {
  const resolveAsset = (name: string): string => resolve(sourceDir, name)
  const isKnownAsset = (name: string): boolean =>
    (WASM_ASSET_FILES as readonly string[]).includes(name)

  return {
    name: 'onlinecad:acadrust-wasm-assets',

    buildStart() {
      const missing = WASM_ASSET_FILES.filter(name => !existsSync(resolveAsset(name)))
      if (missing.length > 0) {
        this.error(
          `Missing acadrust WASM build output (${missing.join(', ')}) in ${sourceDir}.\n` +
            'Build it first:  npm run build:wasm'
        )
      }
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        if (!pathname.startsWith('/wasm/')) {
          next()
          return
        }
        const name = pathname.slice('/wasm/'.length)
        if (!isKnownAsset(name) || !existsSync(resolveAsset(name))) {
          next()
          return
        }
        res.setHeader('content-type', CONTENT_TYPES[name] ?? 'application/octet-stream')
        // Never cache in dev so a rebuilt wasm is picked up on reload.
        res.setHeader('cache-control', 'no-store')
        res.end(readFileSync(resolveAsset(name)))
      })
    },

    generateBundle() {
      for (const name of WASM_ASSET_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `wasm/${name}`,
          source: readFileSync(resolveAsset(name))
        })
      }
    }
  }
}
