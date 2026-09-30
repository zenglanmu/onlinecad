<script setup lang="ts">
/**
 * The drawing register: a searchable index of the drawings a user has opened,
 * served from Cloudflare D1.
 *
 * It is explicitly *not* a file manager. By default files never leave the
 * browser, so an entry records what can be derived — name, size, CAD version,
 * entity and layer counts, notes — and the panel says so, because a user who
 * expects to reopen an unshared drawing from the cloud needs to know why they
 * cannot. Entries that *have* been shared show their link and a revoke action.
 */

import { CloseBold, Delete, Edit, Link, Refresh, Search } from '@element-plus/icons-vue'
import { shareUrl, type Drawing } from '@onlinecad/api-contract'
import { ElMessage, ElMessageBox } from 'element-plus'
import { reactive, ref } from 'vue'

import { copyText } from '../lib/clipboard'
import { cadVersionLabel, entityTypeLabel, formatBytes, formatCount, formatDateTime } from '../lib/format'
import { describeError, useDrawingLibrary } from '../store/drawings'

const visible = defineModel<boolean>({ required: true })

const emit = defineEmits<{
  /** Ask the shell to open its file picker. */
  pick: []
}>()

const { items, total, stats, loading, error, search, formatFilter, refresh, update, remove, unshare } =
  useDrawingLibrary()

const editing = ref<Drawing | null>(null)
const editForm = reactive({ name: '', notes: '', tags: '' })
const savingEdit = ref(false)
/** Id of the entry whose share is being revoked, for the button spinner. */
const revoking = ref<string | null>(null)

function openEditor(drawing: Drawing): void {
  editing.value = drawing
  editForm.name = drawing.name
  editForm.notes = drawing.notes ?? ''
  editForm.tags = drawing.tags.join(', ')
}

/** Close the editor when its dialog is dismissed. */
function closeEditor(open: boolean): void {
  if (!open) editing.value = null
}

async function submitEdit(): Promise<void> {
  const drawing = editing.value
  if (!drawing) return

  savingEdit.value = true
  try {
    await update(drawing.id, {
      name: editForm.name.trim() || drawing.name,
      notes: editForm.notes.trim() || null,
      tags: editForm.tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    })
    editing.value = null
    ElMessage.success('已更新台账记录')
  } catch (cause) {
    ElMessage.error(describeError(cause))
  } finally {
    savingEdit.value = false
  }
}

async function confirmRemove(drawing: Drawing): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要从台账中移除「${drawing.name}」吗？本机图纸文件不受影响。`,
      '移除台账记录',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' }
    )
  } catch {
    // The user cancelled.
    return
  }

  try {
    await remove(drawing.id)
    ElMessage.success('已移除')
  } catch (cause) {
    ElMessage.error(describeError(cause))
  }
}

/** Copy an existing share link. */
async function copyShare(drawing: Drawing): Promise<void> {
  if (!drawing.share) return
  const link = shareUrl(drawing.share.token)
  const copied = await copyText(link)
  if (copied) {
    ElMessage.success('分享链接已复制')
  } else {
    ElMessage.warning(`复制失败，请手动复制：${link}`)
  }
}

async function confirmUnshare(drawing: Drawing): Promise<void> {
  if (!drawing.share) return
  try {
    await ElMessageBox.confirm(
      '取消分享后，保存在云端的原始图纸会被删除，链接立即失效。',
      `取消分享「${drawing.name}」`,
      { type: 'warning', confirmButtonText: '取消分享', cancelButtonText: '保留' }
    )
  } catch {
    // The user cancelled.
    return
  }

  revoking.value = drawing.id
  try {
    await unshare(drawing.id)
    ElMessage.success('已取消分享，云端文件已删除')
  } catch (cause) {
    ElMessage.error(describeError(cause))
  } finally {
    revoking.value = null
  }
}

/** Total entity count across the listed drawings, for the header summary. */
function totalEntities(list: Drawing[]): number {
  return list.reduce((sum, drawing) => sum + drawing.entityCount, 0)
}
</script>

<template>
  <el-drawer v-model="visible" size="560px" :with-header="false" class="library-drawer">
    <div class="library">
      <header class="library__header">
        <div>
          <h2>图纸台账</h2>
          <p class="library__subtitle">
            默认只保存元数据；仅在你主动分享时，原始图纸才会上传到云端。
            共 {{ formatCount(total) }} 条记录，合计
            {{ formatCount(totalEntities(items)) }} 个图元。
          </p>
        </div>
        <el-button :icon="Refresh" circle :loading="loading" @click="refresh" />
      </header>

      <dl v-if="stats && stats.topLayers.length > 0" class="stat-grid stat-grid--compact">
        <div>
          <dt>图纸</dt>
          <dd>{{ formatCount(stats.drawingCount) }}</dd>
        </div>
        <div>
          <dt>合计大小</dt>
          <dd>{{ formatBytes(stats.totalBytes) }}</dd>
        </div>
        <div>
          <dt>图层记录</dt>
          <dd>{{ formatCount(stats.layerCount) }}</dd>
        </div>
      </dl>

      <div class="library__filters">
        <el-input
          v-model="search"
          :prefix-icon="Search"
          placeholder="按名称搜索"
          clearable
          class="library__search"
        />
        <el-select v-model="formatFilter" placeholder="全部格式" clearable class="library__format">
          <el-option label="DWG" value="dwg" />
          <el-option label="DXF" value="dxf" />
        </el-select>
      </div>

      <el-alert
        v-if="error"
        type="error"
        :closable="false"
        show-icon
        :title="error"
        class="library__alert"
      />

      <el-scrollbar class="library__scroll">
        <p v-if="items.length === 0 && !loading" class="library__empty">
          没有匹配的记录。打开一张图纸后点击「存入台账」即可建立索引。
        </p>

        <article v-for="drawing in items" :key="drawing.id" class="entry">
          <header class="entry__head">
            <span class="badge">{{ drawing.format.toUpperCase() }}</span>
            <h3 class="entry__name" :title="drawing.name">{{ drawing.name }}</h3>
            <el-button
              text
              :icon="Edit"
              size="small"
              aria-label="编辑备注"
              @click="openEditor(drawing)"
            />
            <el-button
              text
              :icon="Delete"
              size="small"
              aria-label="移除记录"
              @click="confirmRemove(drawing)"
            />
          </header>

          <div class="entry__facts">
            <span>{{ cadVersionLabel(drawing.cadVersion) }}</span>
            <span>{{ formatBytes(drawing.sizeBytes) }}</span>
            <span>{{ formatCount(drawing.entityCount) }} 图元</span>
            <span>{{ formatCount(drawing.layerCount) }} 图层</span>
          </div>

          <div v-if="Object.keys(drawing.entityTypes).length > 0" class="entry__tags">
            <el-tag
              v-for="(count, kind) in drawing.entityTypes"
              :key="kind"
              size="small"
              type="info"
              effect="plain"
            >
              {{ entityTypeLabel(String(kind)) }} × {{ count }}
            </el-tag>
          </div>

          <div v-if="drawing.layerNames.length > 0" class="entry__layers">
            <span class="entry__label">图层</span>
            <code v-for="layer in drawing.layerNames.slice(0, 8)" :key="layer">{{ layer }}</code>
            <span v-if="drawing.layerNames.length > 8" class="entry__more">
              等 {{ drawing.layerNames.length }} 个
            </span>
          </div>

          <p v-if="drawing.notes" class="entry__notes">{{ drawing.notes }}</p>

          <div v-if="drawing.share" class="entry__share">
            <el-tag size="small" type="success" effect="plain">
              {{
                drawing.share.expiresAt
                  ? `已分享 · ${formatDateTime(drawing.share.expiresAt)} 到期`
                  : '已分享 · 永久有效'
              }}
            </el-tag>
            <el-button text size="small" :icon="Link" @click="copyShare(drawing)">
              复制链接
            </el-button>
            <el-button
              text
              size="small"
              :icon="CloseBold"
              :loading="revoking === drawing.id"
              @click="confirmUnshare(drawing)"
            >
              取消分享
            </el-button>
          </div>

          <footer class="entry__foot">
            <span>{{ formatDateTime(drawing.updatedAt) }}</span>
            <span v-if="drawing.contentHash" class="entry__hash" :title="drawing.contentHash">
              #{{ drawing.contentHash.slice(0, 10) }}
            </span>
          </footer>
        </article>
      </el-scrollbar>

      <footer class="library__footer">
        <el-button type="primary" @click="emit('pick')">打开本机图纸</el-button>
        <span class="library__note">
          未分享的图纸只存在本机，打开时仍需选择本机文件；已分享的图纸可通过链接只读查看。
        </span>
      </footer>
    </div>

    <el-dialog
      :model-value="editing !== null"
      title="编辑台账记录"
      width="420px"
      append-to-body
      @update:model-value="closeEditor"
    >
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="editForm.tags" placeholder="例如：建筑, 已审" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.notes" type="textarea" :rows="4" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = null">取消</el-button>
        <el-button type="primary" :loading="savingEdit" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>
