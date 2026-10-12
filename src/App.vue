<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import {
  ArrowUpRight,
  Play,
  Pause,
  Square,
  SlidersHorizontal,
  Copy,
  Trash2,
  Check,
  Headphones,
  ArrowRight,
  RotateCcw,
  FolderOpen,
  Download,
} from 'lucide-vue-next'
import { useInterpreter } from './stores/interpreter'
import SubtitleFeed from './components/SubtitleFeed.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useHistory } from './composables/useHistory'
import { useLocalInterpreter } from './composables/useLocalInterpreter'
const store = useInterpreter()
const history = useHistory()
const local = useLocalInterpreter(store)
const hasLocal = !!window.desktop?.local
async function openHistory() {
  try {
    await window.desktop?.openHistory()
  } catch {
    notice('无法打开历史文件夹，请稍后重试')
  }
}
const settingsOpen = ref(false),
  confirmation = ref<'restart' | 'clear' | null>(null),
  toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
const names = { Ready: '准备就绪', Listening: '正在监听', Paused: '已暂停', Stopped: '已结束' }
const clock = computed(
  () =>
    `${Math.floor(store.elapsed / 60)
      .toString()
      .padStart(2, '0')}:${Math.floor(store.elapsed % 60)
      .toString()
      .padStart(2, '0')}`,
)
try {
  const saved = JSON.parse(localStorage.getItem('shiyi-settings') || '{}')
  if (['bilingual', 'chinese'].includes(saved.mode)) store.settings.mode = saved.mode
  if (['small', 'standard', 'large'].includes(saved.size)) store.settings.size = saved.size
  if (typeof saved.autoScroll === 'boolean') store.settings.autoScroll = saved.autoScroll
  if (typeof saved.terms === 'boolean') store.settings.terms = saved.terms
} catch {
  /* Unavailable storage uses defaults. */
}
watch(
  () => ({ ...store.settings }),
  (value) => {
    try {
      localStorage.setItem('shiyi-settings', JSON.stringify(value))
    } catch {
      /* Settings remain usable in memory. */
    }
  },
)
function notice(message: string) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 3000)
}
async function copy(id?: number) {
  const text = store.text(id)
  if (!text) {
    notice('还没有已确认的字幕')
    return
  }
  try {
    if (window.desktop) await window.desktop.copy(text)
    else await navigator.clipboard.writeText(text)
    notice(id === undefined ? '已复制全部已确认字幕' : '已复制此条字幕')
  } catch {
    notice('复制失败，请手动选择字幕复制')
  }
}
function restart() {
  if (history.status.value === 'saving') return
  if (store.session.captions.length) confirmation.value = 'restart'
  else start()
}
function start() {
  if (store.source === 'local') void local.begin()
  else store.start()
}
function pause() {
  if (store.source === 'local') local.pause()
  else store.pause()
}
function resume() {
  if (store.source === 'local') void local.begin(true)
  else store.resume()
}
function stop() {
  if (store.source === 'local') local.stop()
  else store.stop()
}
function clear() {
  if (store.source === 'local') local.clear()
  else store.clear()
}
function confirm() {
  if (history.status.value === 'saving') return
  if (confirmation.value === 'restart') start()
  else clear()
  confirmation.value = null
}
onBeforeUnmount(() => {
  local.dispose()
  store.stop()
  clearTimeout(toastTimer)
})
</script>
<template>
  <div class="app-shell">
    <main>
      <section class="interpreter" aria-label="实时翻译器">
        <div class="session-bar">
          <div class="source-label">
            <Headphones :size="16" /><span>技术英文</span>
            <select
              v-model="store.source"
              class="source-select"
              aria-label="音频来源"
              :disabled="!['Ready', 'Stopped'].includes(store.session.status) || local.busy.value"
            >
              <option v-if="hasLocal" value="local">本地麦克风</option>
              <option value="demo">字幕演示</option></select
            ><span class="separator" /><span class="language-pair"
              >EN <ArrowRight :size="12" /> 中文</span
            >
            <div class="status-pill" :class="store.session.status.toLowerCase()">
              <span class="tiny-dot" />{{ names[store.session.status] }}
              <span class="status-en">{{ store.session.status }}</span>
            </div>
          </div>
          <div class="session-actions">
            <time class="session-time"><span class="tiny-dot" />{{ clock }}</time>
            <div v-if="store.session.status !== 'Ready'" class="main-actions">
              <template v-if="store.session.status === 'Listening'"
                ><button class="secondary" @click="pause"><Pause :size="17" />暂停</button
                ><button class="stop-button" @click="stop">
                  <Square :size="13" fill="currentColor" />结束
                </button></template
              ><template v-else-if="store.session.status === 'Paused'"
                ><button v-if="local.busy.value" class="secondary" @click="local.cancelPreparing">
                  取消准备</button
                ><button v-else class="primary" @click="resume">
                  <Play :size="16" fill="currentColor" />继续翻译</button
                ><button class="stop-button" @click="stop">
                  <Square :size="13" fill="currentColor" />结束
                </button></template
              ><template v-else-if="store.session.status === 'Stopped'">
                <button v-if="local.busy.value" class="secondary" @click="local.cancelPreparing">取消准备</button>
                <button v-else class="primary" :disabled="history.status.value === 'saving'" @click="restart">
                  <RotateCcw :size="17" />重新开始
                </button>
              </template>
            </div>
          </div>
        </div>
        <div v-if="local.error.value" class="local-error" role="alert">{{ local.error.value }}</div>
        <div v-if="store.session.status === 'Ready'" class="welcome">
          <div class="sound-orbit">
            <div class="orbit-ring one" />
            <div class="orbit-ring two" />
            <div class="wave-mark">
              <i
                v-for="n in 9"
                :key="n"
                :style="{ '--bar': `${[16, 28, 43, 31, 56, 37, 46, 26, 15][n - 1]}px` }"
              />
            </div>
            <span class="orbit-tag en-tag">Hello.</span><span class="orbit-tag zh-tag">你好。</span>
          </div>
          <span class="welcome-overline">少一点语言距离，多一点专注</span>
          <h2>让理解，跟上每一句。</h2>
          <p>英文原文与中文翻译同步呈现，<br />让你专注正在听的内容。</p>
          <button
            v-if="local.busy.value"
            class="secondary welcome-start"
            @click="local.cancelPreparing"
          >
            正在准备本地模型… 取消
          </button>
          <button v-else class="primary welcome-start" @click="start">
            <Play :size="17" fill="currentColor" />开始翻译<ArrowUpRight :size="17" />
          </button>
          <span class="welcome-note">{{
            store.source === 'local'
              ? '点击开始后会请求麦克风权限；音频仅在本机处理'
              : '点击播放模拟字幕，无需麦克风权限'
          }}</span>
          <div class="feature-strip">
            <span><span class="feature-number">01</span>双语对照</span
            ><span><span class="feature-number">02</span>渐进字幕</span
            ><span><span class="feature-number">03</span>术语保留</span>
          </div>
        </div>
        <template v-else
          ><div v-if="store.session.status === 'Paused'" class="session-notice">
            <Pause :size="14" />已暂停，当前字幕已保留<span>{{
              store.source === 'local' ? '继续后重新启用麦克风' : '继续后播放下一段示例'
            }}</span>
          </div>
          <div v-else-if="store.session.status === 'Stopped'" class="session-notice ended">
            <Check :size="15" /><strong>翻译已结束</strong
            ><span>已保留 {{ store.finalCount }} 条确认字幕，可回看或复制</span>
          </div>
          <SubtitleFeed @copy="copy"
        /></template>
        <div class="reading-toolbar">
          <div class="segmented">
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
          <div class="toolbar-actions">
            <button class="text-button" :disabled="!store.finalCount" @click="copy()">
              <Copy :size="14" />复制全部
            </button>
            <button
              class="text-button muted"
              aria-label="清空记录"
              :disabled="!store.session.captions.length || history.status.value === 'saving'"
              @click="confirmation = 'clear'"
            >
              <Trash2 :size="14" />清空
            </button>
            <button
              class="text-button history-folder-button"
              :disabled="!history.isDesktop"
              :title="
                history.isDesktop
                  ? '打开桌面历史文件夹'
                  : '仅桌面版可打开本地文件夹，浏览器版请下载记录'
              "
              @click="openHistory"
            >
              <FolderOpen :size="14" />实译历史记录
            </button>
            <button
              class="text-button settings-button"
              aria-label="字幕设置"
              @click="settingsOpen = true"
            >
              <SlidersHorizontal :size="16" />字幕设置
            </button>
            <span
              v-if="!['idle', 'empty'].includes(history.status.value)"
              class="toolbar-history-note"
              :class="{ error: history.status.value === 'failed' }"
              role="status"
              :title="history.savedPath.value"
              >{{ history.message.value }}</span
            >
            <div
              v-if="['download', 'downloaded', 'failed'].includes(history.status.value)"
              class="toolbar-history-actions"
            >
              <button
                v-if="history.status.value === 'failed'"
                class="text-button"
                @click="history.save"
              >
                重试保存
              </button>
              <button class="text-button" @click="history.download">
                <Download :size="14" />下载记录
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" /><ConfirmDialog
      v-if="confirmation"
      :kind="confirmation"
      :message="history.confirmationText.value"
      @close="confirmation = null"
      @confirm="confirm"
    />
    <Transition name="toast"
      ><div v-if="toast" class="toast-message" role="status">{{ toast }}</div></Transition
    >
  </div>
</template>
