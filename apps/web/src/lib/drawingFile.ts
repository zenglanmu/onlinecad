/**
 * Turn a local `File` into the metadata the drawing register stores.
 *
 * Nothing here uploads or retains the file: the bytes are read once, summarised
 * with acadrust and hashed, and the `File` stays owned by the page.
 */

import type { DrawingFormat } from '@onlinecad/api-contract'
import type { DrawingSummary } from '@onlinecad/cad-acadrust'

/**
 * The slice of the acadrust engine that metadata parsing needs. Typed
 * structurally so this module (imported by the welcome screen) does not pull in
 * the lazily loaded CAD runtime or its class.
 */
export interface DrawingInspector {
  inspect(data: Uint8Array, isDwg: boolean): Promise<DrawingSummary>
}

export interface LocalDrawingInfo {
  format: DrawingFormat
  /** Parsed metadata: counts, version, layer names, parser health. */
  summary: DrawingSummary
  /** SHA-256 of the file, used to recognise an already-indexed drawing. */
  contentHash: string
  sizeBytes: number
}

export const SUPPORTED_DRAWING_EXTENSIONS = ['.dwg', '.dxf'] as const

/** `drawing.DWG` → `'dwg'`; anything unsupported → `null`. */
export function detectDrawingFormat(fileName: string): DrawingFormat | null {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (extension === '.dwg') return 'dwg'
  if (extension === '.dxf') return 'dxf'
  return null
}

export function isSupportedDrawing(file: File): boolean {
  return detectDrawingFormat(file.name) !== null
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle` needs an `ArrayBuffer`-backed view; a copy also guarantees
  // the buffer is never a `SharedArrayBuffer`.
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Parse and fingerprint a local drawing.
 *
 * Parsing happens in the acadrust worker, so a large DWG does not block the UI
 * while the register entry is being prepared. The engine is passed in by the
 * caller so this module stays free of the (lazily loaded) CAD runtime and can be
 * imported by the welcome screen without pulling the engine in.
 *
 * @throws if the extension is unsupported or the file is not a readable drawing.
 */
export async function inspectLocalFile(
  file: File,
  engine: DrawingInspector
): Promise<LocalDrawingInfo> {
  const format = detectDrawingFormat(file.name)
  if (!format) {
    throw new Error(`不支持的文件类型：${file.name}（仅支持 .dwg 与 .dxf）`)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  // Independent work: the worker conversion and the digest can overlap.
  const [summary, contentHash] = await Promise.all([
    engine.inspect(bytes, format === 'dwg'),
    sha256Hex(bytes)
  ])

  return { format, summary, contentHash, sizeBytes: file.size }
}
