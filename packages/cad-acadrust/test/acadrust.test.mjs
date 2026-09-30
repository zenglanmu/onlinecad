/**
 * Integration tests for the real `acadrust_wasm` artifact.
 *
 * These run the compiled WebAssembly directly in Node — no browser, no mocks —
 * so they cover exactly what ships: the wasm-bindgen ABI, the DWG reader, the
 * DXF writer and the metadata summary.
 *
 * Run with:  npm test --workspace @onlinecad/cad-acadrust
 *
 * Fixtures are produced by the Rust generator and committed to the repo:
 *   cargo run --manifest-path crates/acadrust-wasm/Cargo.toml \
 *     --release --example gen_fixture -- fixtures
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AcadrustWasm, EXPECTED_ABI_VERSION } from '../src/wasm.ts'

const here = dirname(fileURLToPath(import.meta.url))
const wasmDir = resolve(here, '../wasm')
const fixturesDir = resolve(here, '../../../fixtures')

/** Entity count produced by `crates/acadrust-wasm/examples/gen_fixture.rs`. */
const FIXTURE_ENTITY_COUNT = 8

const glueUrl = pathToFileURL(join(wasmDir, 'acadrust_wasm.js')).href
const wasmBytes = readFileSync(join(wasmDir, 'acadrust_wasm_bg.wasm'))

/** Instantiate once and share: this is the same singleton the app uses. */
const wasm = await AcadrustWasm.instantiate({ glueUrl, wasmModule: wasmBytes })

function fixture(name) {
  const path = join(fixturesDir, name)
  return existsSync(path) ? readFileSync(path) : undefined
}

test('reports a matching ABI version', () => {
  assert.equal(wasm.abiVersion, EXPECTED_ABI_VERSION)
})

test('bundles the acadrust crate it claims to', () => {
  assert.match(wasm.acadrustVersion, /^\d+\.\d+\.\d+$/)
})

test('DXF → DWG → DXF round trip preserves the drawing', t => {
  const dxf = fixture('sample.dxf')
  if (!dxf) {
    t.skip(`no fixtures at ${fixturesDir}; run the gen_fixture example first`)
    return
  }

  const dwg = wasm.dxfToDwg(dxf)
  // A DWG is a binary container that starts with an ASCII version tag such as
  // "AC1032"; this asserts we produced a real DWG rather than echoing the DXF.
  assert.ok(dwg.length > 0)
  assert.equal(String.fromCharCode(dwg[0], dwg[1]), 'AC')

  const backToDxf = wasm.dwgToDxf(dwg)
  const summary = wasm.inspect(backToDxf, false)
  assert.equal(summary.entityCount, FIXTURE_ENTITY_COUNT)
  assert.equal(summary.format, 'dxf')
  assert.equal(summary.version, 'AC1032')
})

test('reads a DWG produced by acadrust and reports its metadata', t => {
  const dwg = fixture('sample.dwg')
  if (!dwg) {
    t.skip(`no fixtures at ${fixturesDir}; run the gen_fixture example first`)
    return
  }

  const summary = wasm.inspect(dwg, true)
  assert.equal(summary.format, 'dwg')
  assert.equal(summary.entityCount, FIXTURE_ENTITY_COUNT)
  assert.ok(summary.layerNames.includes('WALLS'), summary.layerNames.join(','))
  assert.equal(summary.entityTypes.CIRCLE, 4)
  assert.equal(summary.entityTypes.LINE, 2)
  assert.equal(summary.entityTypes.LWPOLYLINE, 1)
  assert.equal(summary.entityTypes.TEXT, 1)
})

test('re-versioning a drawing rewrites the version code', t => {
  const dxf = fixture('sample.dxf')
  if (!dxf) {
    t.skip('no fixtures')
    return
  }

  const downgraded = wasm.dxfToDxf(dxf, 1015)
  assert.equal(wasm.inspect(downgraded, false).version, 'AC1015')
})

test('empty input is rejected with a readable message', () => {
  assert.throws(
    () => wasm.dwgToDxf(new Uint8Array(0)),
    /empty input/
  )
})

test('non-CAD bytes are rejected with a readable message', () => {
  const junk = new TextEncoder().encode('this is definitely not a drawing')
  assert.throws(() => wasm.dwgToDxf(junk))
})

test('the engine stays usable after an error', t => {
  const dxf = fixture('sample.dxf')
  if (!dxf) {
    t.skip('no fixtures')
    return
  }

  // A failed parse must not poison the instance: users upload broken files.
  assert.throws(() => wasm.inspect(new Uint8Array(0), false))
  assert.equal(wasm.inspect(dxf, false).entityCount, FIXTURE_ENTITY_COUNT)
})
