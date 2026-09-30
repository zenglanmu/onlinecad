<script setup lang="ts">
/**
 * About panel.
 *
 * Beyond credits, this is the app's "what is actually running" disclosure: the
 * acadrust version is read back from the loaded WebAssembly module, and the
 * ABI/version check is what fails loudly if a stale `.wasm` is deployed
 * alongside newer glue.
 */

import { EXPECTED_ABI_VERSION, loadAcadrustWasm } from '@onlinecad/cad-acadrust'
import { ref, watch } from 'vue'

const visible = defineModel<boolean>({ required: true })

const engineVersion = ref<string | null>(null)
const engineError = ref<string | null>(null)

watch(visible, async open => {
  if (!open || engineVersion.value !== null || engineError.value !== null) return
  try {
    const wasm = await loadAcadrustWasm()
    engineVersion.value = wasm.acadrustVersion
  } catch (cause) {
    engineError.value = cause instanceof Error ? cause.message : String(cause)
  }
})
</script>

<template>
  <el-dialog v-model="visible" title="关于 OnlineCAD" width="560px">
    <div class="about">
      <p>
        一个完全在浏览器中运行的 DWG/DXF 查看与编辑应用。图纸文件默认不会离开你的设备，
        服务端提供静态资源、图纸台账（元数据）接口，以及你主动分享时的只读链接。
      </p>

      <h3>运行时</h3>
      <ul>
        <li>
          <strong>acadrust</strong>
          <span v-if="engineVersion">v{{ engineVersion }}</span>
          <span v-else-if="engineError" class="about__error">读取失败：{{ engineError }}</span>
          <span v-else>读取中…</span>
          <span class="about__muted">· MPL-2.0 · DWG R13–R2018 读写</span>
        </li>
        <li>
          <strong>WASM ABI</strong><span>v{{ EXPECTED_ABI_VERSION }}</span>
          <span class="about__muted">· 版本不匹配时会拒绝加载</span>
        </li>
        <li>
          <strong>@mlightcad/cad-viewer</strong>
          <span class="about__muted">· MIT · 渲染与编辑</span>
        </li>
        <li>
          <strong>Cloudflare Workers + D1 + R2</strong>
          <span class="about__muted">· 静态资源、图纸台账、分享文件</span>
        </li>
      </ul>

      <h3>为什么 DWG 用 acadrust</h3>
      <p class="about__note">
        cad-viewer 本身不内置 DWG 解析器：官方的开源方案依赖 GPL-3.0 的 LibreDWG，
        商业方案需单独购买。acadrust 是 MPL-2.0 的纯 Rust 实现，既能读也能写 DWG，
        因此「编辑后导出真正的 DWG」才成为可能。
      </p>

      <h3>数据在哪里</h3>
      <ul>
        <li>图纸内容：默认只存在于你的浏览器内存与本地磁盘。</li>
        <li>
          分享的文件：仅当你主动分享时，原始图纸才会写入 Cloudflare R2，
          并可通过只读链接查看；取消分享或删除记录时，云端文件一并删除。
        </li>
        <li>台账记录：Cloudflare D1，包含文件名、大小、版本、图元/图层统计与备注。</li>
        <li>识别依据：图纸的 SHA-256 摘要，用于避免重复建档。</li>
      </ul>
    </div>
  </el-dialog>
</template>
