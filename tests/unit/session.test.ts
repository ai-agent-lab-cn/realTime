import { describe, it, expect } from 'vitest'
import { createSession, command, accept, copyText, type Event } from '../../src/domain/session'
const event = (epoch: number, patch: Partial<Event> = {}): Event => ({
  epoch,
  id: 1,
  revision: 1,
  en: 'We need RAG.',
  zh: '我们需要 RAG。',
  final: false,
  time: 0,
  ...patch,
})
describe('字幕状态规则', () => {
  it('合法状态变化；重复开始不重置正在进行的一轮', () => {
    const s = createSession()
    command(s, 'start')
    expect(s.status).toBe('Listening')
    const epoch = s.epoch
    command(s, 'start')
    expect(s.epoch).toBe(epoch)
    command(s, 'pause')
    expect(s.status).toBe('Paused')
    command(s, 'resume')
    expect(s.status).toBe('Listening')
    command(s, 'stop')
    expect(s.status).toBe('Stopped')
    command(s, 'resume')
    expect(s.status).toBe('Stopped')
  })
  it('Partial 更新同一条，拒绝旧版本和重复事件，Final 后固定', () => {
    const s = createSession()
    command(s, 'start')
    accept(s, event(s.epoch))
    accept(s, event(s.epoch, { revision: 3, en: 'New' }))
    accept(s, event(s.epoch, { revision: 2, en: 'Old' }))
    expect(s.captions).toHaveLength(1)
    expect(s.captions[0].en).toBe('New')
    accept(s, event(s.epoch, { revision: 4, final: true }))
    accept(s, event(s.epoch, { revision: 5, en: 'Wrong' }))
    expect(s.captions[0].en).toBe('We need RAG.')
    expect(s.captions[0].final).toBe(true)
  })
  it('暂停及恢复后拒绝暂停前的迟到结果', () => {
    const s = createSession()
    command(s, 'start')
    const e = event(s.epoch)
    accept(s, e)
    command(s, 'pause')
    accept(s, { ...e, revision: 2, final: true })
    expect(s.captions[0].final).toBe(false)
    command(s, 'resume')
    accept(s, { ...e, revision: 3, final: true })
    expect(s.captions[0].final).toBe(false)
  })
  it('结束保留记录，重新开始隔离旧结果', () => {
    const s = createSession()
    command(s, 'start')
    const e = event(s.epoch)
    accept(s, e)
    command(s, 'stop')
    expect(s.captions).toHaveLength(1)
    accept(s, { ...e, revision: 2, final: true })
    expect(s.captions[0].final).toBe(false)
    command(s, 'start')
    accept(s, e)
    expect(s.captions).toHaveLength(0)
  })
  it('复制全部默认只含 Final，可复制单条中文', () => {
    const s = createSession()
    command(s, 'start')
    accept(s, event(s.epoch, { final: true }))
    accept(s, event(s.epoch, { id: 2 }))
    expect(copyText(s, 'bilingual')).toBe('We need RAG.\n我们需要 RAG。')
    expect(copyText(s, 'chinese', 1)).toBe('我们需要 RAG。')
    expect(copyText(s, 'chinese', 2)).toBe('')
  })
  it('清空保留当前状态且阻止旧事件重新填入', () => {
    const s = createSession()
    command(s, 'start')
    const e = event(s.epoch)
    accept(s, e)
    command(s, 'clear')
    accept(s, e)
    expect(s.captions).toHaveLength(0)
    expect(s.status).toBe('Listening')
  })
})
