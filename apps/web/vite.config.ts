import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import { acadrustWasmAssets } from './plugins/acadrustWasmAssets'

/** `@onlinecad/cad-acadrust/wasm/` — the wasm-bindgen build output. */
const wasmDir = fileURLToPath(new URL('../../packages/cad-acadrust/wasm/', import.meta.url))

/**
 * Opt-in host allow-list for the dev/preview servers.
 *
 * Vite only accepts `localhost` and bare IP addresses by default; a request
 * arriving through a domain — Cloudflare Tunnel, a reverse proxy, a cloud VM
 * with a DNS name — is rejected with `Blocked request. This host is not
 * allowed.` (the guard exists to prevent DNS-rebinding attacks, so it is not
 * disabled by default).
 *
 *   VITE_ALLOWED_HOSTS=cad.example.com npm run dev:host
 *   VITE_ALLOWED_HOSTS=* npm run dev:host          # allow any Host header
 */
function allowedHosts(): true | string[] | undefined {
  const configured = process.env.VITE_ALLOWED_HOSTS?.trim()
  if (!configured) return undefined
  if (configured === '*') return true
  return configured
    .split(',')
    .map(host => host.trim())
    .filter(Boolean)
}

export default defineConfig({
  plugins: [
    vue(),
    // Emits /wasm/acadrust_wasm.js and /wasm/acadrust_wasm_bg.wasm, which the
    // engine loads at runtime (see packages/cad-acadrust/src/wasm.ts).
    acadrustWasmAssets(wasmDir)
  ],

  resolve: {
    // The viewer's packages declare vue/three/etc. as peer dependencies; keeping
    // one copy is required for Vue's runtime to match the compiled SFCs and for
    // THREE's instanceof checks across @mlightcad/three-renderer.
    dedupe: ['vue', 'vue-i18n', 'element-plus', 'three', '@mlightcad/data-model']
  },

  server: {
    // Skipped entirely unless configured, so the default stays permissive to
    // localhost/IPs only.
    ...(allowedHosts() !== undefined ? { allowedHosts: allowedHosts() } : {}),
    /**
     * Forward the register API to `wrangler dev`.
     *
     * Without this, the app served from :5173 has no `/api`, so the drawing
     * register is dead in development. Point `ONLINECAD_API_TARGET` elsewhere
     * to use a deployed Worker instead:
     *
     *   ONLINECAD_API_TARGET=https://onlinecad.example.workers.dev npm run dev
     */
    proxy: {
      '/api': {
        target: process.env.ONLINECAD_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },

  preview: {
    ...(allowedHosts() !== undefined ? { allowedHosts: allowedHosts() } : {})
  },

  worker: {
    // The DWG parser worker is created with `{ type: 'module' }`, so its bundle
    // must be an ES module.
    format: 'es'
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    // The viewer + THREE bundle is legitimately large; the default 500 kB
    // warning would just be noise.
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        /**
         * One chunk per third-party package.
         *
         * Without this, Rollup splits `@mlightcad/*` re-export chains (for
         * example `geometry-engine`'s `math/index.js` re-exporting a module
         * that landed in another chunk) across chunks, which it warns can break
         * module execution order. Grouping per package keeps every re-export
         * chain in a single chunk while preserving laziness: the PDF/SVG/HTML
         * plugins still load only when their command runs.
         */
        manualChunks: (id: string) => {
          if (!id.includes('node_modules/')) return undefined
          // Only the viewer's packages need pinning: their `index.js` barrels
          // re-export modules that Rollup otherwise assigns to other chunks.
          const mlightcad = /node_modules\/@mlightcad\/([^/]+)\//.exec(id)
          if (mlightcad) return `mlightcad-${mlightcad[1]}`
          // THREE is shared by the viewer, the renderer and the exporters.
          if (/node_modules\/three\//.test(id)) return 'three'
          return undefined
        }
      }
    }
  },

  optimizeDeps: {
    // Everything is pre-bundled on first dev run; listing the heavier viewer
    // packages explicitly avoids a full-page reload mid-session when the viewer
    // lazily imports an export plugin.
    include: [
      'vue',
      'vue-i18n',
      'element-plus',
      'three',
      'lodash-es',
      '@mlightcad/data-model',
      '@mlightcad/cad-simple-viewer'
    ]
  }
})
