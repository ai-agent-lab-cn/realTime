import type { Caption } from './session'
export interface HistoryRecord {
  id: string
  startedAt: string
  endedAt: string
  captions: Caption[]
  source?: 'demo' | 'local'
}
export function historyMarkdown(record: HistoryRecord): string {
  const time = (seconds: number) =>
    `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0')}`
  return [
    '# 实译历史记录',
    '',
    record.source === 'local'
      ? '> 来源：本地麦克风采集，经本地语音识别与翻译处理。'
      : '> 模拟数据：由前端 Demo 预设语料生成，不是真实语音识别或翻译结果。',
    '',
    `- 开始时间：${new Date(record.startedAt).toLocaleString('zh-CN')}`,
    `- 结束时间：${new Date(record.endedAt).toLocaleString('zh-CN')}`,
    `- 记录编号：${record.id}`,
    '',
    ...record.captions.flatMap((c) => [
      `## ${time(c.time)} · ${c.final ? '已确认' : '未确认（内容可能不完整）'}`,
      '',
      ...(c.error ? [`处理提示：${c.error}`, ''] : []),
      `原文：${c.en}`,
      '',
      `中文：${c.zh}`,
      '',
    ]),
  ].join('\n')
}
