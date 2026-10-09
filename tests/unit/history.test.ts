import { it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveHistory } from '../../electron/history'
import { historyMarkdown } from '../../src/domain/history'
const id = '11111111-1111-4111-8111-111111111111'
const request = { id, startedAt: '2026-10-08T13:00:00.000Z', content: '# 模拟数据\n英文与中文' }
it('历史保留双语及未确认标记，并注明模拟数据', () => {
  const text = historyMarkdown({
    id,
    startedAt: request.startedAt,
    endedAt: '2026-10-08T13:01:00.000Z',
    captions: [
      { id: 1, revision: 1, en: 'Hello', zh: '你好', final: false, time: 1 },
      { id: 2, revision: 2, en: 'Done', zh: '完成', final: true, time: 3 },
    ],
  })
  expect(text).toContain('模拟数据')
  expect(text).toContain('未确认')
  expect(text).toContain('Hello')
  expect(text).toContain('你好')
  expect(text).toContain('已确认')
  expect(text).toContain('00:01')
})
it('创建目录、同轮重试与并发不重复保存，不同轮不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiyi-history-'))
  try {
    const dir = join(root, '历史')
    const [a, b] = await Promise.all([saveHistory(dir, request), saveHistory(dir, request)])
    expect(a).toBe(b)
    expect(await readFile(a, 'utf8')).toBe(request.content)
    await saveHistory(dir, { ...request, id: '22222222-2222-4222-8222-222222222222' })
    expect((await readdir(dir)).filter((f) => f.endsWith('.md'))).toHaveLength(2)
    await expect(saveHistory(dir, { ...request, content: 'changed' })).rejects.toThrow()
    expect(await readFile(a, 'utf8')).toBe(request.content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('拒绝任意文件路径，写入失败会抛错而非虚假成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiyi-history-'))
  try {
    await expect(saveHistory(root, { ...request, id: '../../outside' })).rejects.toThrow()
    const file = join(root, 'file')
    await writeFile(file, 'exists')
    await expect(saveHistory(file, request)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('exists')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
