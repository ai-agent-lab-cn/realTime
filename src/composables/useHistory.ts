import { ref, computed, watch } from 'vue'
import { useInterpreter } from '../stores/interpreter'
import { historyMarkdown } from '../domain/history'
export function useHistory() {
  const store = useInterpreter()
  const status = ref<'idle' | 'saving' | 'saved' | 'failed' | 'download' | 'downloaded' | 'empty'>(
    'idle',
  )
  const savedPath = ref('')
  let snapshot: { id: string; startedAt: string; content: string } | null = null
  const isDesktop = !!window.desktop
  const message = computed(
    () =>
      ({
        idle: isDesktop ? '结束后自动保存到桌面「实译历史记录」' : '浏览器预览 · 结束后可下载记录',
        saving: '正在保存历史记录…',
        saved: '已保存到桌面「实译历史记录」',
        failed: '保存失败，记录仍在当前页面，请重试或下载备份',
        download: '浏览器预览：记录尚未保存，请下载',
        downloaded: '已发起下载，请在浏览器下载中确认',
        empty: '本轮没有字幕，无需保存',
      })[status.value],
  )
  watch(
    () => store.recordId,
    () => {
      snapshot = null
      status.value = 'idle'
      savedPath.value = ''
    },
    { flush: 'sync' },
  )
  watch(
    () => store.session.status,
    (state) => {
      if (state !== 'Stopped') return
      if (!store.session.captions.length) {
        status.value = 'empty'
        return
      }
      snapshot = {
        id: store.recordId,
        startedAt: store.startedAt,
        content: historyMarkdown({
          id: store.recordId,
          startedAt: store.startedAt,
          endedAt: new Date().toISOString(),
          captions: store.session.captions.map((c) => ({ ...c })),
          source: store.source,
        }),
      }
      if (isDesktop) void save()
      else status.value = 'download'
    },
    { flush: 'sync' },
  )
  async function save() {
    if (!snapshot || !window.desktop || status.value === 'saving') return
    const record = snapshot
    status.value = 'saving'
    try {
      const path = await window.desktop.saveHistory(record)
      if (snapshot === record) {
        savedPath.value = path
        status.value = 'saved'
      }
    } catch {
      if (snapshot === record) status.value = 'failed'
    }
  }
  function download() {
    if (!snapshot) return
    const url = URL.createObjectURL(
      new Blob([snapshot.content], { type: 'text/markdown;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `实译_${snapshot.startedAt.replace(/[:.]/g, '-')}_${snapshot.id}.md`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    if (!isDesktop) status.value = 'downloaded'
  }
  const confirmationText = computed(() =>
    status.value === 'saved'
      ? '本轮历史已经保存。此操作仅清除页面记录，不会删除桌面历史文件。'
      : status.value === 'saving'
        ? '历史正在保存，请稍候。'
        : '当前内容尚未确认保存到历史文件。请先结束翻译并保存或下载；继续操作将清除页面记录。',
  )
  return { status, savedPath, isDesktop, message, save, download, confirmationText }
}
