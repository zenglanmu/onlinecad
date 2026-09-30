/**
 * Drawing-register state.
 *
 * A module-level singleton because the register is shared by the welcome screen
 * and the library drawer; components read the same reactive values instead of
 * each fetching their own copy.
 */

import { ref } from 'vue'
import {
  DrawingApiError,
  createDrawingsClient,
  type Drawing,
  type DrawingInput,
  type DrawingPatch,
  type DrawingStats,
  type ShareInput
} from '@onlinecad/api-contract'

export const drawingsClient = createDrawingsClient()

const items = ref<Drawing[]>([])
const total = ref(0)
const stats = ref<DrawingStats | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const search = ref('')
const formatFilter = ref<'' | 'dwg' | 'dxf'>('')

/** A message that is safe to show directly to the user. */
export function describeError(cause: unknown): string {
  if (cause instanceof DrawingApiError) return cause.message
  if (cause instanceof Error) return cause.message
  return String(cause)
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  const name = search.value.trim()
  try {
    const result = await drawingsClient.list({
      limit: 50,
      ...(name ? { q: name } : {}),
      ...(formatFilter.value ? { format: formatFilter.value } : {})
    })
    items.value = result.items
    total.value = result.total
  } catch (cause) {
    error.value = describeError(cause)
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function refreshStats(): Promise<void> {
  try {
    stats.value = await drawingsClient.stats()
  } catch {
    // Statistics are decorative; a failure must not surface as an error banner
    // over an otherwise working register.
    stats.value = null
  }
}

async function save(input: DrawingInput): Promise<Drawing> {
  const drawing = await drawingsClient.create(input)
  await Promise.all([refresh(), refreshStats()])
  return drawing
}

async function update(id: string, patch: DrawingPatch): Promise<Drawing> {
  const drawing = await drawingsClient.update(id, patch)
  items.value = items.value.map(item => (item.id === id ? drawing : item))
  return drawing
}

async function remove(id: string): Promise<void> {
  await drawingsClient.remove(id)
  items.value = items.value.filter(item => item.id !== id)
  total.value = Math.max(0, total.value - 1)
  await refreshStats()
}

/** Publish the original file; returns the entry with its new `share`. */
async function share(id: string, file: File, input?: ShareInput): Promise<Drawing> {
  const drawing = await drawingsClient.share(id, file, input)
  items.value = items.value.map(item => (item.id === id ? drawing : item))
  return drawing
}

/** Revoke the link and delete the stored file. */
async function unshare(id: string): Promise<Drawing> {
  const drawing = await drawingsClient.unshare(id)
  items.value = items.value.map(item => (item.id === id ? drawing : item))
  return drawing
}

export function useDrawingLibrary() {
  return {
    items,
    total,
    stats,
    loading,
    error,
    search,
    formatFilter,
    refresh,
    refreshStats,
    save,
    update,
    remove,
    share,
    unshare
  }
}
