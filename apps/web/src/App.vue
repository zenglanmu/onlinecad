<script setup lang="ts">
/**
 * Application shell.
 *
 * Owns the one piece of state that cannot live elsewhere: which local `File` is
 * open. The file is handed to the viewer as a `File` and to acadrust as bytes
 * when an index entry or a DWG export is needed; it only ever leaves the page
 * through the explicit share flow below.
 *
 * The shell also dispatches `/s/<token>` to the public read-only {@link ShareView}
 * and everything else to the editor.
 */

import { Collection, Download, Files, InfoFilled } from '@element-plus/icons-vue'
import { AcApDocManager, AcEdOpenMode } from '@mlightcad/cad-simple-viewer'
import { MlCadViewer } from '@mlightcad/cad-viewer'
import { DXF_VERSION_AC1032 } from '@onlinecad/cad-acadrust'
import { shareUrl, type Drawing } from '@onlinecad/api-contract'
import { ElMessage } from 'element-plus'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import AboutDialog from './components/AboutDialog.vue'
import DrawingLibraryDrawer from './components/DrawingLibraryDrawer.vue'
import ShareDialog from './components/ShareDialog.vue'
import ShareView from './components/ShareView.vue'
import WelcomeScreen from './components/WelcomeScreen.vue'
import { acadrustEngine } from './lib/acadrust'
import { copyText } from './lib/clipboard'
import { downloadBytes } from './lib/download'
import {
  detectDrawingFormat,
  inspectLocalFile,
  type LocalDrawingInfo
} from './lib/drawingFile'
import { replaceExtension } from './lib/format'
import { describeError, useDrawingLibrary } from './store/drawings'

const {
  error,
  search,
  formatFilter,
  refresh,
  refreshStats,
  save,
  share
} = useDrawingLibrary()

const currentFile = ref<File | null>(null)
/** Metadata for the open file, filled in by the background parse. */
const localInfo = ref<LocalDrawingInfo | null>(null)
/** Bumped per open so `MlCadViewer` remounts and reloads the new file. */
const viewerKey = ref(0)
const saving = ref(false)
const exporting = ref(false)
const libraryVisible = ref(false)
const aboutVisible = ref(false)
const filePicker = ref<HTMLInputElement | null>(null)

/**
 * `/s/<token>` is the public share page; every other path is the editor. A
 * regex is enough here — the app has exactly one extra route, and it is
 * server-rendered to `index.html` by the SPA asset fallback.
 */
function readShareToken(): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname)
  return match ? decodeURIComponent(match[1]) : null
}

const shareToken = ref<string | null>(readShareToken())

/** The entry being offered for sharing, and whether the upload is in flight. */
const shareTarget = ref<Drawing | null>(null)
const shareDialogVisible = ref(false)
const sharing = ref(false)

onMounted(() => {
  // The share page talks only to the share API; it has no register to warm up.
  if (shareToken.value) return
  void refresh()
  void refreshStats()
})

// Searching hits the API, so debounce keystrokes.
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch([search, formatFilter], () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void refresh(), 250)
})
onUnmounted(() => clearTimeout(searchTimer))

function pickFile(): void {
  filePicker.value?.click()
}

function onPickerChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset so picking the same file twice still fires a change event.
  input.value = ''
  if (file) openFile(file)
}

function openFile(file: File): void {
  if (!detectDrawingFormat(file.name)) {
    ElMessage.error('仅支持 .dwg 与 .dxf 图纸')
    return
  }
  currentFile.value = file
  localInfo.value = null
  viewerKey.value += 1
  libraryVisible.value = false
  void analyse(file)
}

/**
 * Parse the file in the background. Doing it up front means "存入台账" is
 * instant and a fragmentary drawing can be reported as soon as it opens.
 */
async function analyse(file: File): Promise<void> {
  try {
    const info = await inspectLocalFile(file)
    // Discard a stale result if another drawing was opened meanwhile.
    if (currentFile.value !== file) return
    localInfo.value = info
    if (info.summary.recovered) {
      ElMessage.warning(
        `图纸已打开，但解析器恢复了 ${info.summary.diagnostics} 处损坏内容，部分图元可能缺失。`
      )
    }
  } catch (cause) {
    if (currentFile.value === file) {
      ElMessage.error(`无法解析该图纸：${describeError(cause)}`)
    }
  }
}

async function saveToLibrary(): Promise<void> {
  const file = currentFile.value
  if (!file) return

  saving.value = true
  try {
    const info = localInfo.value ?? (await inspectLocalFile(file))
    localInfo.value = info
    const drawing = await save({
      name: file.name,
      format: info.format,
      sizeBytes: info.sizeBytes,
      contentHash: info.contentHash,
      cadVersion: info.summary.version,
      entityCount: info.summary.entityCount,
      layerCount: info.summary.layerCount,
      layerNames: info.summary.layerNames,
      entityTypes: info.summary.entityTypes
    })
    ElMessage.success('已存入图纸台账')

    if (drawing.share) {
      ElMessage.info('该图纸已有分享链接，可在「图纸台账」中复制或取消分享。')
    } else {
      // Ask, always. Saving metadata never implies uploading the file; the
      // prompt is the only path to sharing.
      shareTarget.value = drawing
      shareDialogVisible.value = true
    }
  } catch (cause) {
    ElMessage.error(describeError(cause))
  } finally {
    saving.value = false
  }
}

/**
 * Publish the original file after the user confirms in the share dialog.
 *
 * The link is copied to the clipboard so the user can paste it immediately; if
 * the clipboard is unavailable (plain-HTTP origin) the URL is shown instead of
 * failing silently.
 */
async function confirmShare(expiresInDays: number | null): Promise<void> {
  const drawing = shareTarget.value
  const file = currentFile.value
  if (!drawing || !file) return

  sharing.value = true
  try {
    const updated = await share(drawing.id, file, { expiresInDays })
    const link = updated.share ? shareUrl(updated.share.token) : ''
    const copied = link.length > 0 ? await copyText(link) : false
    ElMessage.success(
      copied ? '已上传原始图纸，分享链接已复制到剪贴板' : `已生成分享链接：${link}`
    )
    shareDialogVisible.value = false
    shareTarget.value = null
  } catch (cause) {
    ElMessage.error(`分享失败：${describeError(cause)}`)
  } finally {
    sharing.value = false
  }
}

/**
 * Export what is on screen as a real DWG.
 *
 * The viewer's DXF serializer (`dxfOut`) is the same one behind its own "Export
 * DXF", so the exported drawing is exactly what the user sees; acadrust then
 * re-encodes those bytes as binary DWG. This is the payoff of choosing a DWG
 * engine that can *write* the format, not just read it.
 */
async function exportDwg(): Promise<void> {
  const file = currentFile.value
  if (!file) return

  exporting.value = true
  try {
    const cadDocument = AcApDocManager.instance.curDocument
    const serialized: unknown = cadDocument.database.dxfOut(undefined, 6)
    const dxfBytes =
      typeof serialized === 'string'
        ? new TextEncoder().encode(serialized)
        : new Uint8Array(serialized as ArrayBufferLike)

    const dwg = await acadrustEngine.dxfToDwg(dxfBytes, DXF_VERSION_AC1032)
    downloadBytes(
      dwg,
      replaceExtension(cadDocument.fileName || file.name, '.dwg'),
      'application/acad'
    )
    ElMessage.success('已导出 DWG')
  } catch (cause) {
    ElMessage.error(`导出 DWG 失败：${describeError(cause)}`)
  } finally {
    exporting.value = false
  }
}

function closeDrawing(): void {
  currentFile.value = null
  localInfo.value = null
  void refresh()
}
</script>

<template>
  <!-- Public read-only share page. Everything else is the editor shell. -->
  <ShareView v-if="shareToken" :token="shareToken" />

  <div v-else class="shell">
    <header class="appbar">
      <div class="appbar__brand">
        <span class="appbar__logo" aria-hidden="true">◈</span>
        <span class="appbar__titles">
          <strong>OnlineCAD</strong>
          <small>DWG / DXF · 浏览器本地解析与编辑</small>
        </span>
      </div>

      <div class="appbar__actions">
        <el-tag v-if="localInfo" size="small" effect="plain" class="appbar__tag">
          {{ localInfo.format.toUpperCase() }} · {{ localInfo.summary.version }}
        </el-tag>

        <el-button :icon="Files" @click="libraryVisible = true">图纸台账</el-button>

        <template v-if="currentFile">
          <el-button :icon="Collection" :loading="saving" @click="saveToLibrary">
            存入台账
          </el-button>
          <el-button type="primary" :icon="Download" :loading="exporting" @click="exportDwg">
            导出 DWG
          </el-button>
          <el-button text @click="closeDrawing">关闭图纸</el-button>
        </template>

        <el-button text :icon="InfoFilled" aria-label="关于" @click="aboutVisible = true" />
      </div>
    </header>

    <main class="stage">
      <WelcomeScreen
        v-if="!currentFile"
        @pick="pickFile"
        @pick-file="openFile"
        @open-library="libraryVisible = true"
      />
      <div v-else class="stage__viewer">
        <MlCadViewer
          :key="viewerKey"
          locale="zh"
          :local-file="currentFile"
          :mode="AcEdOpenMode.Write"
          :progressive-rendering="true"
        />
      </div>
    </main>

    <DrawingLibraryDrawer v-model="libraryVisible" @pick="pickFile" />
    <AboutDialog v-model="aboutVisible" />

    <!-- Sharing is opt-in: this only opens from the save flow above. -->
    <ShareDialog
      v-model="shareDialogVisible"
      :drawing-name="shareTarget?.name ?? ''"
      :size-bytes="shareTarget?.sizeBytes ?? 0"
      :busy="sharing"
      @confirm="confirmShare"
    />

    <!-- Central file picker: children ask for a file rather than owning inputs. -->
    <input
      ref="filePicker"
      class="hidden-input"
      type="file"
      accept=".dwg,.dxf,application/acad,application/x-acad,image/vnd.dwg,image/vnd.dxf"
      @change="onPickerChange"
    />

    <el-alert
      v-if="error"
      class="stage__error"
      type="error"
      :closable="false"
      show-icon
      :title="`图纸台账加载失败：${error}`"
    />
  </div>
</template>
