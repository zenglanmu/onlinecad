<script setup lang="ts">
/**
 * Public share page: `/s/<token>`.
 *
 * This is the recipient's view. It is deliberately outside the editor shell —
 * no register, no file picker, no export — because the token grants read access
 * to one drawing and nothing else. The bytes come from R2 via the share API and
 * are handed to the same viewer the editor uses, in read-only mode.
 */

import { Download } from '@element-plus/icons-vue'
import { AcEdOpenMode } from '@mlightcad/cad-simple-viewer'
import { MlCadViewer } from '@mlightcad/cad-viewer'
import { createSharesClient, type PublicShare } from '@onlinecad/api-contract'
import { computed, onMounted, ref } from 'vue'

import { cadVersionLabel, formatBytes, formatCount, formatDateTime } from '../lib/format'
import { describeError } from '../store/drawings'

const props = defineProps<{ token: string }>()

const sharesClient = createSharesClient()

const info = ref<PublicShare | null>(null)
const file = ref<File | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)

const downloadUrl = computed(() => sharesClient.contentUrl(props.token, { download: true }))

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const detail = await sharesClient.get(props.token)

    // Pull the bytes and wrap them in a `File`, so the viewer takes the exact
    // same path it does for a locally opened drawing — including the DWG →
    // DXF conversion inside the acadrust worker.
    const response = await fetch(sharesClient.contentUrl(props.token))
    if (!response.ok) {
      throw new Error(`图纸下载失败（HTTP ${response.status}）`)
    }
    const blob = await response.blob()

    info.value = detail
    file.value = new File([blob], detail.share.fileName, {
      type: detail.share.format === 'dwg' ? 'application/acad' : 'application/dxf'
    })
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="share-view">
    <header class="share-view__bar">
      <div class="share-view__brand">
        <span class="share-view__logo" aria-hidden="true">◈</span>
        <span class="share-view__titles">
          <strong>OnlineCAD 分享</strong>
          <small>只读预览</small>
        </span>
      </div>

      <div class="share-view__actions">
        <span v-if="info" class="share-view__name" :title="info.share.fileName">
          {{ info.share.fileName }}
        </span>
        <el-button
          v-if="info"
          tag="a"
          type="primary"
          :icon="Download"
          :href="downloadUrl"
        >
          下载原文件
        </el-button>
      </div>
    </header>

    <main class="share-view__stage">
      <div v-if="loading" v-loading="true" class="share-view__state" />
      <el-result
        v-else-if="error"
        icon="error"
        title="无法打开分享链接"
        :sub-title="error"
      >
        <template #extra>
          <el-button @click="load">重试</el-button>
        </template>
      </el-result>

      <template v-else-if="file">
        <dl v-if="info?.drawing" class="share-view__facts">
          <div>
            <dt>格式</dt>
            <dd>{{ info.share.format.toUpperCase() }}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{{ cadVersionLabel(info.drawing.cadVersion) }}</dd>
          </div>
          <div>
            <dt>大小</dt>
            <dd>{{ formatBytes(info.share.sizeBytes) }}</dd>
          </div>
          <div>
            <dt>图元 / 图层</dt>
            <dd>
              {{ formatCount(info.drawing.entityCount) }} /
              {{ formatCount(info.drawing.layerCount) }}
            </dd>
          </div>
          <div>
            <dt>分享于</dt>
            <dd>{{ formatDateTime(info.share.createdAt) }}</dd>
          </div>
        </dl>

        <div class="share-view__viewer">
          <MlCadViewer
            :local-file="file"
            locale="zh"
            :mode="AcEdOpenMode.Read"
            :progressive-rendering="true"
          />
        </div>
      </template>
    </main>
  </div>
</template>
