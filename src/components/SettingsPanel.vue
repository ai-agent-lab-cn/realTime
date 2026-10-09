<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { X, Type, Languages, ArrowDownToLine, BookOpen } from 'lucide-vue-next'
import { useInterpreter } from '../stores/interpreter'
const store = useInterpreter()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
</script>
<template>
  <dialog
    ref="dialog"
    class="settings-dialog"
    @cancel.prevent="emit('close')"
    @click="
      (e) => {
        if (e.target === dialog) emit('close')
      }
    "
  >
    <div class="dialog-heading">
      <div>
        <span class="eyebrow">MAKE IT YOURS</span>
        <h2>字幕设置</h2>
      </div>
      <button class="icon-button" aria-label="关闭设置" @click="emit('close')">
        <X :size="20" />
      </button>
    </div>
    <section class="setting-row">
      <h3><Languages :size="17" /> 显示语言</h3>
      <div class="segmented full">
        <button
          :class="{ selected: store.settings.mode === 'bilingual' }"
          @click="store.settings.mode = 'bilingual'"
        >
          英文 + 中文</button
        ><button
          :class="{ selected: store.settings.mode === 'chinese' }"
          @click="store.settings.mode = 'chinese'"
        >
          仅中文
        </button>
      </div>
    </section>
    <section class="setting-row">
      <h3><Type :size="17" /> 字体大小</h3>
      <div class="segmented full">
        <button
          v-for="item in [
            ['small', '小'],
            ['standard', '标准'],
            ['large', '大'],
          ] as const"
          :key="item[0]"
          :class="{ selected: store.settings.size === item[0] }"
          @click="store.settings.size = item[0]"
        >
          {{ item[1] }}
        </button>
      </div>
    </section>
    <label class="setting-row toggle-row"
      ><div>
        <h3><ArrowDownToLine :size="17" /> 自动滚动</h3>
        <p>让最新字幕保持可见</p>
      </div>
      <input
        v-model="store.settings.autoScroll"
        type="checkbox"
        aria-label="自动滚动"
        role="switch"
    /></label>
    <label class="setting-row toggle-row"
      ><div>
        <h3><BookOpen :size="17" /> 保留技术术语</h3>
        <p>优先保留 RAG、Embedding、Agent 等表达</p>
      </div>
      <input v-model="store.settings.terms" type="checkbox" aria-label="保留技术术语" role="switch"
    /></label>
    <div class="term-preview">
      <span>内置术语示例</span>
      <div><code>RAG</code><code>Embedding</code><code>Agent</code><code>PR</code></div>
      <p>设置对后续生成的字幕生效，已确认内容保持不变。</p>
    </div>
    <p class="settings-note">设置仅保存在此设备。桌面版结束后自动保存历史；浏览器版可下载记录。</p>
  </dialog>
</template>
