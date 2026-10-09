<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { Copy, Check, ArrowDown, AudioLines } from 'lucide-vue-next'
import { useInterpreter } from '../stores/interpreter'
const store = useInterpreter()
const emit = defineEmits<{ copy: [id: number] }>()
const feed = ref<HTMLElement>()
const away = ref(false)
const size = computed(() => `size-${store.settings.size}`)
function time(value: number) {
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(value % 60)
    .toString()
    .padStart(2, '0')}`
}
function scroll() {
  const el = feed.value
  if (el) away.value = el.scrollHeight - el.scrollTop - el.clientHeight > 80
}
async function bottom() {
  await nextTick()
  const el = feed.value
  if (el) {
    el.scrollTop = el.scrollHeight
    away.value = false
  }
}
watch(
  () => store.session.captions.map((c) => `${c.id}:${c.revision}`).join(','),
  () => {
    if (store.settings.autoScroll && !away.value) void bottom()
  },
)
watch(
  () => store.settings.autoScroll,
  (on) => {
    if (on) void bottom()
  },
)
</script>
<template>
  <div class="feed-wrap">
    <div
      ref="feed"
      class="feed"
      :class="size"
      @scroll="scroll"
      aria-label="当前翻译记录"
      tabindex="0"
    >
      <article
        v-for="caption in store.session.captions"
        :key="caption.id"
        class="caption"
        :class="{ final: caption.final, partial: !caption.final }"
      >
        <div class="caption-meta">
          <time>{{ time(caption.time) }}</time
          ><span v-if="!caption.final" class="partial-label"
            ><span class="tiny-dot" />{{
              store.session.status === 'Listening' && caption === store.session.captions.at(-1)
                ? '正在生成'
                : '未确认'
            }}</span
          ><span v-else class="confirmed"><Check :size="12" /> 已确认</span>
          <button
            class="icon-button copy-line"
            :disabled="!caption.final"
            aria-label="复制此条字幕"
            title="复制此条字幕"
            @click="emit('copy', caption.id)"
          >
            <Copy :size="15" />
          </button>
        </div>
        <p v-if="store.settings.mode === 'bilingual'" class="english">{{ caption.en }}</p>
        <p class="chinese">{{ caption.zh }}</p>
      </article>
      <div v-if="!store.session.captions.length" class="waiting">
        <AudioLines :size="32" />
        <p>
          {{ store.session.status === 'Listening' ? '正在等待下一段模拟语音…' : '当前还没有字幕' }}
        </p>
        <span>本次记录会显示在这里</span>
      </div>
      <div v-else-if="store.session.status === 'Listening'" class="listening-tail">
        <span class="tiny-dot" /> 正在接收模拟语音
      </div>
    </div>
    <button v-if="away" class="back-latest" @click="bottom">
      <ArrowDown :size="14" /> 回到最新
    </button>
  </div>
</template>
