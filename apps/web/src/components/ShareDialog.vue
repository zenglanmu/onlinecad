<script setup lang="ts">
/**
 * The share prompt.
 *
 * This dialog exists because sharing is the one action that moves a drawing's
 * bytes off the device — the opposite of the app's default. The copy therefore
 * states the consequence in plain words ("anyone with the link can open the
 * original file") instead of hiding it behind a checkbox, and offers the
 * lifetime up front.
 */

import { Link } from '@element-plus/icons-vue'
import { ref, watch } from 'vue'

import { formatBytes } from '../lib/format'

const visible = defineModel<boolean>({ required: true })

defineProps<{
  /** Name of the drawing about to be published. */
  drawingName: string
  sizeBytes: number
  /** True while the upload is in flight, so the dialog stays open. */
  busy: boolean
}>()

const emit = defineEmits<{
  /** `null` means the link never expires. */
  confirm: [expiresInDays: number | null]
}>()

/** 0 is the "never expires" sentinel; positive values are whole days. */
const validity = ref(0)

watch(visible, open => {
  if (open) validity.value = 0
})

function submit(): void {
  emit('confirm', validity.value === 0 ? null : validity.value)
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="生成分享链接？"
    width="460px"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      class="share-dialog__alert"
      title="这一步会把原始图纸文件上传到云端"
    >
      <p class="share-dialog__lead">
        其他功能都在本地完成。只有生成分享链接时，
        <strong>{{ drawingName }}</strong>
        （{{ formatBytes(sizeBytes) }}）的原始文件才会保存到 Cloudflare R2，
        并可由任何拿到链接的人查看。
      </p>
    </el-alert>

    <el-form label-position="top" class="share-dialog__form">
      <el-form-item label="链接有效期">
        <el-radio-group v-model="validity" :disabled="busy">
          <el-radio :value="0">永久</el-radio>
          <el-radio :value="7">7 天</el-radio>
          <el-radio :value="30">30 天</el-radio>
          <el-radio :value="90">90 天</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <p class="share-dialog__note">
      可随时在「图纸台账」中取消分享，云端文件会一并删除。
    </p>

    <template #footer>
      <el-button :disabled="busy" @click="visible = false">暂不分享</el-button>
      <el-button type="primary" :icon="Link" :loading="busy" @click="submit">
        上传并生成链接
      </el-button>
    </template>
  </el-dialog>
</template>
