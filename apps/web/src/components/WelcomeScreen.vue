<script setup lang="ts">
/**
 * Landing view: drop a drawing, or glance at the register.
 *
 * The drag-and-drop target is deliberately the whole panel, and the copy spells
 * out that opening a drawing uploads nothing — the default is the product's
 * central promise, so it is stated where the user decides whether to trust it.
 * Sharing is a separate, explicit step.
 */

import { Files, FolderOpened, UploadFilled } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'

import { SUPPORTED_DRAWING_EXTENSIONS } from '../lib/drawingFile'
import { cadVersionLabel, formatBytes, formatCount, formatDateTime } from '../lib/format'
import { useDrawingLibrary } from '../store/drawings'

const emit = defineEmits<{
  /** Ask the shell to open its file picker. */
  pick: []
  /** A file was dropped directly on this panel. */
  'pick-file': [file: File]
  'open-library': []
}>()

const { stats, items, loading } = useDrawingLibrary()

const dragging = ref(false)

/** Recent register entries, newest first (the API already sorts). */
const recent = computed(() => items.value.slice(0, 5))

const acceptAttribute = SUPPORTED_DRAWING_EXTENSIONS.join(',')

function onDragOver(): void {
  dragging.value = true
}

function onDragLeave(): void {
  dragging.value = false
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  // Validation lives in the shell so both paths share one error message.
  if (file) emit('pick-file', file)
}
</script>

<template>
  <div class="welcome">
    <section class="welcome__hero">
      <h1>在浏览器中查看与编辑 CAD 图纸</h1>
      <p class="welcome__lede">
        支持 <strong>DWG</strong> 与 <strong>DXF</strong>。图纸文件不会上传到任何服务器 ——
        解析、渲染、编辑全部在你的设备上完成。
      </p>

      <div
        class="dropzone"
        :class="{ 'dropzone--active': dragging }"
        role="button"
        tabindex="0"
        @click="emit('pick')"
        @keydown.enter.space.prevent="emit('pick')"
        @dragover.prevent="onDragOver"
        @dragenter.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <el-icon :size="42" class="dropzone__icon"><UploadFilled /></el-icon>
        <p class="dropzone__title">把图纸拖到这里，或点击选择文件</p>
        <p class="dropzone__hint">支持扩展名：{{ acceptAttribute }}</p>
      </div>

      <ul class="welcome__facts">
        <li>
          <strong>acadrust</strong>（Rust 编译为 WebAssembly）负责 DWG 的读取与写出，
          MPL-2.0 许可，不依赖 GPL 的 LibreDWG。
        </li>
        <li>
          <strong>@mlightcad/cad-viewer</strong>（MIT）负责渲染与编辑；
          图纸先转为 DXF，再交给它自己的解析管线。
        </li>
        <li>
          图纸台账默认只保存图层、图元统计、备注等<strong>元数据</strong>；
          只有你主动选择「分享」时，原始图纸文件才会保存到云端 R2 并生成只读链接。
        </li>
      </ul>
    </section>

    <aside class="welcome__side">
      <header class="welcome__side-header">
        <h2>图纸台账</h2>
        <el-button text :icon="FolderOpened" @click="emit('open-library')">全部</el-button>
      </header>

      <dl v-if="stats" class="stat-grid">
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

      <div v-loading="loading" class="welcome__recent">
        <p v-if="recent.length === 0" class="welcome__empty">
          还没有台账记录。打开一张图纸后点击「存入台账」即可建立索引。
        </p>
        <ul v-else class="recent-list">
          <li v-for="drawing in recent" :key="drawing.id">
            <div class="recent-list__row">
              <span class="badge">{{ drawing.format.toUpperCase() }}</span>
              <span class="recent-list__name" :title="drawing.name">{{ drawing.name }}</span>
            </div>
            <div class="recent-list__meta">
              {{ cadVersionLabel(drawing.cadVersion) }} ·
              {{ formatCount(drawing.entityCount) }} 个图元 ·
              {{ formatCount(drawing.layerCount) }} 个图层
            </div>
            <div class="recent-list__meta">
              {{ formatBytes(drawing.sizeBytes) }} · {{ formatDateTime(drawing.updatedAt) }}
            </div>
          </li>
        </ul>
      </div>

      <el-button class="welcome__cta" :icon="Files" @click="emit('open-library')">
        打开图纸台账
      </el-button>
    </aside>
  </div>
</template>
