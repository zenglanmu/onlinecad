# AGENTS.md

Browser-local DWG/DXF viewer/editor. `README.md` is Chinese and is the detailed
source of truth (architecture, privacy model, deployment, limitations). Trust
code/config over the README if they diverge.

## Repo shape

npm workspaces (`packages/*`, `apps/*`) plus one standalone Rust crate. No
monorepo tool — root scripts just delegate to a workspace.

- `crates/acadrust-wasm/` — Rust → WASM bridge; the DWG read/write engine. A
  cargo crate, **not** an npm workspace.
- `packages/cad-acadrust/` — TS package registering the WASM as a cad-viewer DWG
  converter. Owns the only test suite.
- `packages/api-contract/` — shared API types + client.
- `apps/web/` — Vue 3 SPA (Vite).
- `apps/worker/` — Cloudflare Worker: static `ASSETS` + D1 index + R2 shares.

`packages/*` export raw `src/index.ts` through `exports`; there is no package
build step. Do not add one.

## Build order (most common mistake)

`npm run build:wasm` must run **before** `npm run build`, `npm test`, or any dev
session that opens a DWG. It writes `packages/cad-acadrust/wasm/`, which is
gitignored. The Vite plugin and the Node tests fail loudly when it is missing.

The WASM build needs Rust, the `wasm32-unknown-unknown` target, and
`wasm-bindgen-cli` pinned to **0.2.129**. `scripts/build-wasm.sh` hardcodes that
version and aborts when the installed CLI differs — keep it in sync with the
`wasm-bindgen` pin in `crates/acadrust-wasm/Cargo.toml`. The script does not read
Cargo.toml, so crate/CLI drift slips through and only fails at runtime with a
schema-version error.

The JS-facing ABI is versioned in two places that must match: `ABI_VERSION` in
`crates/acadrust-wasm/src/lib.rs` and `EXPECTED_ABI_VERSION` in
`packages/cad-acadrust/src/wasm.ts`. The loader refuses a mismatched artifact;
bump both together whenever the exported surface changes.

## Commands

```bash
npm run build:wasm        # required first; ~1-2 min
npm run db:migrate:local  # once, before first worker dev
npm run dev:worker        # wrangler dev: simulated local D1+R2, 0.0.0.0:8787
npm run dev               # Vite 5173, proxies /api -> 8787
npm run dev:host          # Vite bound to 0.0.0.0 (LAN access)
npm run typecheck         # all workspaces (web uses vue-tsc)
npm test                  # cad-acadrust integration tests (real WASM, Node)
npm run fixtures          # regenerate fixtures via cargo (committed already)
npm run build             # production SPA build
npm run deploy            # wrangler deploy
```

Rust checks: `cargo test --manifest-path crates/acadrust-wasm/Cargo.toml --lib`,
`cargo fmt ... --check`, `cargo clippy ... --all-targets -- -D warnings`.

There is **no** JS/TS linter or formatter configured. Rust fmt/clippy and the
tsconfig strict flags are the only style gates.

## Tests

- `npm test` runs `tsx --test test/*.test.mjs` in `@onlinecad/cad-acadrust` only;
  `apps/worker` has no tests.
- It instantiates the real compiled WASM in Node — the artifact must exist.
- Fixtures (`fixtures/sample.dwg`, `fixtures/sample.dxf`) are committed; tests
  skip rather than fail if they are missing.
- Run one test:
  `npx tsx --test --test-name-pattern "round trip" packages/cad-acadrust/test/*.test.mjs`
- Rust unit tests cover pure logic; Node tests cover the wasm-bindgen ABI and
  error recovery. The split is intentional — don't duplicate across them.

## Browser verification

No browser automation is installed in this repo. To drive the app (Vite dev
server or the built Worker) headlessly, use the user-local Chromium documented at
`/home/zenglanmu/.local/share/headless-browser/README.md`. Wrappers on `PATH`:

- `headless-shot <url> <out.png> [--mobile --full ...]` — screenshot a page.
- `headless-node <script.mjs>` — run a Playwright script with the browser
  resolvable. Put the script under
  `~/.local/share/headless-browser/scripts/` so `playwright-core` imports resolve.
- `headless-chrome` — raw Chromium for one-off flags.

## CI

`.github/workflows/ci.yml` runs `rust` first (fmt, clippy `-D warnings`, lib
tests, build WASM, upload artifact) then `node` (`npm ci`, download artifact,
`npm run typecheck`, `npm test`, `npm run build`). Preserve that order.

## Dev / env gotchas

- Root `dev` script ends with `--`. `npm run dev -- --host 0.0.0.0` works; a bare
  `npm run dev --host 0.0.0.0` does not (npm swallows it). `npm run dev:host` is
  the shortcut.
- `VITE_ALLOWED_HOSTS` allows non-localhost Host headers (Vite DNS-rebinding
  guard); `ONLINECAD_API_TARGET` points the Vite `/api` proxy at a deployed
  Worker.
- `wrangler dev` simulates D1/R2 locally and ignores the `database_id` and
  bucket names in `apps/worker/wrangler.jsonc`.
- **Never expose the Vite dev server publicly** — it serves source and `/@fs/`
  reads local files. Share via `npm run build` + `npm run dev:worker`, or deploy.

## Code conventions that differ from defaults

- Every tsconfig sets `verbatimModuleSyntax` + `isolatedModules` + `strict` +
  `noUnused*`. Use `import type` for type-only imports or `npm run typecheck`
  fails.
- Vite `dedupe`s vue/vue-i18n/element-plus/three/`@mlightcad/data-model`, and
  `manualChunks` pins one Rollup chunk per `@mlightcad/*` package and `three`;
  this is required for correct runtime module order, not just bundle size. The
  DWG parser worker is built as an ES module (`worker.format: 'es'`).
- Worker routing: `/api/*` is the only dynamic path; everything else is static
  assets with SPA fallback. The API has **no auth**. Metadata request bodies over
  64 KB return 413; share uploads are capped at 256 MB.
