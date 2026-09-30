/**
 * D1 access layer for the drawing index.
 *
 * Layer names are stored twice, on purpose:
 * * `drawings.layer_names` (JSON) — read path, so listing drawings is one query
 *   and never N+1;
 * * `drawing_layers` (normalized) — filter/search path, so `?layer=` can use an
 *   index and `stats` can count distinct layers cheaply.
 *
 * The JSON copy is derived from the normalized rows on every write, so they
 * cannot drift.
 */

import type {
  Drawing,
  DrawingFormat,
  DrawingInput,
  DrawingListQuery,
  DrawingShare,
  DrawingStats
} from '@onlinecad/api-contract'

/**
 * {@link DrawingListQuery} with pagination resolved. The route handler clamps
 * and defaults these before they reach SQL.
 */
export type ResolvedListQuery = DrawingListQuery & {
  limit: number
  offset: number
}

/** Raw column names as D1 returns them. */
interface DrawingRow {
  id: string
  name: string
  format: string
  size_bytes: number
  content_hash: string | null
  cad_version: string | null
  entity_count: number
  layer_count: number
  layer_names: string | null
  entity_types: string | null
  notes: string | null
  tags: string | null
  share_token: string | null
  share_file_name: string | null
  share_size_bytes: number | null
  share_created_at: string | null
  share_expires_at: string | null
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = `
  id, name, format, size_bytes, content_hash, cad_version,
  entity_count, layer_count, layer_names, entity_types,
  notes, tags,
  share_token, share_file_name, share_size_bytes, share_created_at, share_expires_at,
  created_at, updated_at
`

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    // A corrupt auxiliary column must not take down the whole listing.
    return fallback
  }
}

function toDrawing(row: DrawingRow): Drawing {
  const format: DrawingFormat = row.format === 'dwg' ? 'dwg' : 'dxf'
  return {
    id: row.id,
    name: row.name,
    format,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    cadVersion: row.cad_version,
    entityCount: row.entity_count,
    layerCount: row.layer_count,
    layerNames: parseJson<string[]>(row.layer_names, []),
    entityTypes: parseJson<Record<string, number>>(row.entity_types, {}),
    notes: row.notes,
    tags: parseJson<string[]>(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    share: toShare(row, format)
  }
}

/** `share_token` is the flag: no token means nothing is stored server-side. */
function toShare(row: DrawingRow, format: DrawingFormat): DrawingShare | null {
  if (!row.share_token) return null
  return {
    token: row.share_token,
    fileName: row.share_file_name ?? row.name,
    format,
    sizeBytes: row.share_size_bytes ?? row.size_bytes,
    createdAt: row.share_created_at ?? row.created_at,
    expiresAt: row.share_expires_at
  }
}

export async function getDrawing(
  db: D1Database,
  id: string
): Promise<Drawing | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM drawings WHERE id = ?1`)
    .bind(id)
    .first<DrawingRow>()
  return row ? toDrawing(row) : null
}

/** Resolve a public share token back to its register entry. */
export async function getDrawingByShareToken(
  db: D1Database,
  token: string
): Promise<Drawing | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM drawings WHERE share_token = ?1`)
    .bind(token)
    .first<DrawingRow>()
  return row ? toDrawing(row) : null
}

/** Record a freshly published link. Call only after the R2 put succeeded. */
export async function setDrawingShare(
  db: D1Database,
  id: string,
  share: {
    token: string
    fileName: string
    sizeBytes: number
    expiresAt: string | null
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE drawings SET
         share_token = ?2, share_file_name = ?3, share_size_bytes = ?4,
         share_created_at = ?5, share_expires_at = ?6
       WHERE id = ?1`
    )
    .bind(
      id,
      share.token,
      share.fileName,
      share.sizeBytes,
      new Date().toISOString(),
      share.expiresAt
    )
    .run()
}

/** Forget the link. The caller deletes the R2 object. */
export async function clearDrawingShare(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE drawings SET
         share_token = NULL, share_file_name = NULL, share_size_bytes = NULL,
         share_created_at = NULL, share_expires_at = NULL
       WHERE id = ?1`
    )
    .bind(id)
    .run()
}

export async function listDrawings(
  db: D1Database,
  query: ResolvedListQuery
): Promise<{ items: Drawing[]; total: number }> {
  const where: string[] = []
  const bindings: unknown[] = []

  if (query.q) {
    where.push(`d.name LIKE ?${bindings.length + 1} ESCAPE '\\'`)
    bindings.push(`%${escapeLike(query.q)}%`)
  }
  if (query.format) {
    where.push(`d.format = ?${bindings.length + 1}`)
    bindings.push(query.format)
  }
  if (query.layer) {
    where.push(
      `EXISTS (SELECT 1 FROM drawing_layers l WHERE l.drawing_id = d.id AND l.layer_name = ?${bindings.length + 1})`
    )
    bindings.push(query.layer)
  }
  if (query.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(d.tags) t WHERE t.value = ?${bindings.length + 1})`
    )
    bindings.push(query.tag)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS.split(',')
        .map(column => `d.${column.trim()}`)
        .join(', ')}
       FROM drawings d
       ${whereSql}
       ORDER BY d.updated_at DESC, d.name ASC
       LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`
    )
    .bind(...bindings, query.limit, query.offset)
    .all<DrawingRow>()

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM drawings d ${whereSql}`)
    .bind(...bindings)
    .first<{ total: number }>()

  return {
    items: (rows.results ?? []).map(toDrawing),
    total: totalRow?.total ?? 0
  }
}

/**
 * Create or update a drawing index entry.
 *
 * When a `contentHash` is supplied and already indexed, the existing row is
 * updated — so re-saving the same local file refines one entry instead of
 * creating duplicates.
 */
export async function saveDrawing(
  db: D1Database,
  input: DrawingInput
): Promise<Drawing> {
  const now = new Date().toISOString()
  const layerNames = dedupe(input.layerNames ?? []).slice(0, 1000)
  const tags = dedupe(input.tags ?? [])
  const layerNamesJson = JSON.stringify(layerNames)
  const entityTypesJson = JSON.stringify(input.entityTypes ?? {})
  const tagsJson = JSON.stringify(tags)
  const layerCount = input.layerCount ?? layerNames.length

  let id: string | null = null
  if (input.contentHash) {
    const existing = await db
      .prepare('SELECT id FROM drawings WHERE content_hash = ?1')
      .bind(input.contentHash)
      .first<{ id: string }>()
    id = existing?.id ?? null
  }

  if (id) {
    await db
      .prepare(
        `UPDATE drawings SET
           name = ?2, format = ?3, size_bytes = ?4, cad_version = ?5,
           entity_count = ?6, layer_count = ?7, layer_names = ?8,
           entity_types = ?9, tags = ?10, updated_at = ?11,
           notes = COALESCE(?12, notes)
         WHERE id = ?1`
      )
      .bind(
        id,
        input.name,
        input.format,
        input.sizeBytes,
        input.cadVersion ?? null,
        input.entityCount ?? 0,
        layerCount,
        layerNamesJson,
        entityTypesJson,
        tagsJson,
        now,
        input.notes ?? null
      )
      .run()
  } else {
    id = crypto.randomUUID()
    await db
      .prepare(
        `INSERT INTO drawings (
           id, name, format, size_bytes, content_hash, cad_version,
           entity_count, layer_count, layer_names, entity_types,
           notes, tags, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      )
      .bind(
        id,
        input.name,
        input.format,
        input.sizeBytes,
        input.contentHash ?? null,
        input.cadVersion ?? null,
        input.entityCount ?? 0,
        layerCount,
        layerNamesJson,
        entityTypesJson,
        input.notes ?? null,
        tagsJson,
        now,
        now
      )
      .run()
  }

  await replaceLayers(db, id, layerNames)

  const saved = await getDrawing(db, id)
  if (!saved) {
    throw new Error('The drawing row disappeared immediately after being written.')
  }
  return saved
}

export async function updateDrawing(
  db: D1Database,
  id: string,
  patch: { name?: string; notes?: string | null; tags?: string[] }
): Promise<Drawing | null> {
  const existing = await getDrawing(db, id)
  if (!existing) return null

  const assignments: string[] = []
  const bindings: unknown[] = []

  if (patch.name !== undefined) {
    assignments.push(`name = ?${bindings.length + 1}`)
    bindings.push(patch.name)
  }
  if (patch.notes !== undefined) {
    assignments.push(`notes = ?${bindings.length + 1}`)
    bindings.push(patch.notes)
  }
  if (patch.tags !== undefined) {
    assignments.push(`tags = ?${bindings.length + 1}`)
    bindings.push(JSON.stringify(dedupe(patch.tags)))
  }

  assignments.push(`updated_at = ?${bindings.length + 1}`)
  bindings.push(new Date().toISOString())

  await db
    .prepare(
      `UPDATE drawings SET ${assignments.join(', ')} WHERE id = ?${bindings.length + 1}`
    )
    .bind(...bindings, id)
    .run()

  return getDrawing(db, id)
}

export async function deleteDrawing(db: D1Database, id: string): Promise<boolean> {
  const existing = await db
    .prepare('SELECT id FROM drawings WHERE id = ?1')
    .bind(id)
    .first<{ id: string }>()
  if (!existing) return false

  // D1 batches are transactional, so the index never keeps a layer row whose
  // drawing is gone.
  await db.batch([
    db.prepare('DELETE FROM drawing_layers WHERE drawing_id = ?1').bind(id),
    db.prepare('DELETE FROM drawings WHERE id = ?1').bind(id)
  ])
  return true
}

export async function getStats(db: D1Database): Promise<DrawingStats> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS drawing_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
       FROM drawings`
    )
    .first<{ drawing_count: number; total_bytes: number }>()

  const layerTotals = await db
    .prepare('SELECT COUNT(*) AS layer_count FROM drawing_layers')
    .first<{ layer_count: number }>()

  const byFormat = await db
    .prepare('SELECT format, COUNT(*) AS count FROM drawings GROUP BY format')
    .all<{ format: string; count: number }>()

  const topLayers = await db
    .prepare(
      `SELECT layer_name, COUNT(*) AS drawing_count
       FROM drawing_layers
       GROUP BY layer_name
       ORDER BY drawing_count DESC, layer_name ASC
       LIMIT 20`
    )
    .all<{ layer_name: string; drawing_count: number }>()

  const formats: Record<string, number> = {}
  for (const row of byFormat.results ?? []) {
    formats[row.format] = row.count
  }

  return {
    drawingCount: totals?.drawing_count ?? 0,
    totalBytes: totals?.total_bytes ?? 0,
    layerCount: layerTotals?.layer_count ?? 0,
    byFormat: formats,
    topLayers: (topLayers.results ?? []).map(row => ({
      layerName: row.layer_name,
      drawingCount: row.drawing_count
    }))
  }
}

/** Keep `layer_names` and `drawing_layers` in lockstep. */
async function replaceLayers(
  db: D1Database,
  drawingId: string,
  layerNames: string[]
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM drawing_layers WHERE drawing_id = ?1').bind(drawingId)
  ]
  for (const layerName of layerNames) {
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO drawing_layers (drawing_id, layer_name) VALUES (?1, ?2)'
        )
        .bind(drawingId, layerName)
    )
  }
  await db.batch(statements)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

/** Escape `%`/`_` so a user searching for "A_1" does not match "AB1". */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}
