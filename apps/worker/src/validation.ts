/**
 * Validation for {@link DrawingInput}.
 *
 * Hand-rolled rather than schema-library-driven: the payload is a fixed, small
 * shape, and every message here is written to be shown directly in the UI.
 * Anything that is not metadata the browser can compute locally is rejected,
 * which is also what keeps drawing bytes off the server.
 */

import type { DrawingFormat, DrawingInput } from '@onlinecad/api-contract'

/** Metadata objects must stay small; this is not an upload endpoint. */
export const MAX_BODY_BYTES = 64 * 1024
const MAX_NAME_LENGTH = 512
const MAX_NOTES_LENGTH = 8000
const MAX_LAYER_NAMES = 1000
const MAX_TAGS = 32
const MAX_TAG_LENGTH = 64
const MAX_ENTITY_TYPES = 256

export class ValidationError extends Error {
  override readonly name = 'ValidationError'
}

function fail(message: string): never {
  throw new ValidationError(message)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`"${field}" must be an object.`)
  }
  return value as Record<string, unknown>
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail(`"${field}" must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > maxLength) {
    fail(`"${field}" must be at most ${maxLength} characters.`)
  }
  return trimmed
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalString(value, field, maxLength)
  if (parsed === null) fail(`"${field}" is required.`)
  return parsed
}

function optionalCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`"${field}" must be a non-negative number.`)
  }
  return Math.floor(value)
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`"${field}" must be an array.`)
  if (value.length > maxItems) {
    fail(`"${field}" must contain at most ${maxItems} entries.`)
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') fail(`"${field}" must contain only strings.`)
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > maxLength) {
      fail(`Entries in "${field}" must be at most ${maxLength} characters.`)
    }
    seen.add(trimmed)
  }
  return [...seen]
}

function optionalEntityTypes(value: unknown): Record<string, number> {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'entityTypes')
  const keys = Object.keys(record)
  if (keys.length > MAX_ENTITY_TYPES) {
    fail(`"entityTypes" must contain at most ${MAX_ENTITY_TYPES} entries.`)
  }
  const result: Record<string, number> = {}
  for (const key of keys) {
    const count = record[key]
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      fail(`"entityTypes.${key}" must be a non-negative number.`)
    }
    if (key.length > MAX_TAG_LENGTH) {
      fail(`Entity type names must be at most ${MAX_TAG_LENGTH} characters.`)
    }
    result[key] = Math.floor(count)
  }
  return result
}

function optionalHash(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail('"contentHash" must be a string.')
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    fail('"contentHash" must be a 64-character hex SHA-256 digest.')
  }
  return normalized
}

function requiredFormat(value: unknown): DrawingFormat {
  if (value !== 'dwg' && value !== 'dxf') {
    fail('"format" must be either "dwg" or "dxf".')
  }
  return value
}

/** Parse and validate a `POST`/`PATCH` body. Throws {@link ValidationError}. */
export function parseDrawingInput(body: unknown): DrawingInput {
  const record = asRecord(body, 'body')
  return {
    name: requiredString(record.name, 'name', MAX_NAME_LENGTH),
    format: requiredFormat(record.format),
    sizeBytes: optionalCount(record.sizeBytes, 'sizeBytes'),
    contentHash: optionalHash(record.contentHash),
    cadVersion: optionalString(record.cadVersion, 'cadVersion', 32),
    entityCount: optionalCount(record.entityCount, 'entityCount'),
    layerCount: optionalCount(record.layerCount, 'layerCount'),
    layerNames: optionalStringArray(record.layerNames, 'layerNames', MAX_LAYER_NAMES, 255),
    entityTypes: optionalEntityTypes(record.entityTypes),
    notes: optionalString(record.notes, 'notes', MAX_NOTES_LENGTH),
    tags: optionalStringArray(record.tags, 'tags', MAX_TAGS, MAX_TAG_LENGTH)
  }
}

/** Fields a `PATCH` is allowed to change. */
export interface DrawingPatch {
  name?: string
  notes?: string | null
  tags?: string[]
}

export function parseDrawingPatch(body: unknown): DrawingPatch {
  const record = asRecord(body, 'body')
  const patch: DrawingPatch = {}
  if (record.name !== undefined) {
    patch.name = requiredString(record.name, 'name', MAX_NAME_LENGTH)
  }
  if (record.notes !== undefined) {
    patch.notes = optionalString(record.notes, 'notes', MAX_NOTES_LENGTH)
  }
  if (record.tags !== undefined) {
    patch.tags = optionalStringArray(record.tags, 'tags', MAX_TAGS, MAX_TAG_LENGTH)
  }
  if (Object.keys(patch).length === 0) {
    fail('Provide at least one of "name", "notes" or "tags".')
  }
  return patch
}
