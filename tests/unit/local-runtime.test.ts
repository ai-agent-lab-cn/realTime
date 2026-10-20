import { expect, it, vi } from 'vitest'
import { LocalRuntime } from '../../electron/local-runtime'
const token = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222'
const input = () => ({
  token,
  id: 0,
  revision: 1,
  pcm: new Float32Array(16000).buffer,
  final: true,
  time: 0,
  terms: true,
})
function models() {
  return {
    prepare: vi.fn(async () => {}),
    recognize: vi.fn(async () => 'Hello'),
    translate: vi.fn(async () => '你好'),
    close: vi.fn(),
  }
}
it('filters silence before translation and normalizes terms', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('[BLANK_AUDIO]')
  expect(await r.transcribe(input())).toEqual({ en: '', zh: '' })
  expect(m.translate).not.toHaveBeenCalled()
  m.recognize.mockResolvedValueOnce('rag API')
  expect((await r.transcribe(input())).en).toBe('RAG API')
})
it('cancellation prevents late recognition from starting translation or replacing new session', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let resolve!: (s: string) => void
  m.recognize.mockImplementationOnce(
    () =>
      new Promise<string>((yes) => {
        resolve = yes
      }),
  )
  const job = r.transcribe(input())
  await Promise.resolve()
  r.cancel(token)
  const prepared = r.prepare(other)
  resolve('stale')
  await prepared
  await expect(job).rejects.toThrow()
  expect(m.translate).not.toHaveBeenCalled()
  r.cancel(token)
  expect((await r.transcribe({ ...input(), token: other })).zh).toBe('你好')
})
it('retains recognized original if translation fails, and rejects concurrent work', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.translate.mockRejectedValueOnce(new Error('timeout'))
  const result = await r.transcribe(input())
  expect(result.en).toBe('Hello')
  expect(result.zh).toBe('')
  expect(result.error).toBeTruthy()
  let finish!: (s: string) => void
  m.recognize.mockImplementationOnce(
    () =>
      new Promise<string>((yes) => {
        finish = yes
      }),
  )
  const pending = r.transcribe(input())
  await Promise.resolve()
  await expect(r.transcribe(input())).rejects.toThrow()
  finish('hi')
  await pending
})
it('cancel while preparing cannot authorize or resurrect an old token', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let ready!: () => void
  m.prepare.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        ready = yes
      }),
  )
  const start = r.prepare(token)
  r.cancel(token)
  expect(m.close).toHaveBeenCalledOnce()
  ready()
  await expect(start).rejects.toThrow()
  await expect(r.transcribe(input())).rejects.toThrow()
})

it('quarantines runaway ASR rather than translating or confirming it', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  for (const text of [
    'Because firstly ' + 'the percentage of '.repeat(40),
    'We have a lot of resources and '.repeat(6),
  ]) {
    m.recognize.mockResolvedValueOnce(text)
    const result = await r.transcribe({ ...input(), pcm: new Float32Array(160000).buffer })
    expect(result.en).toBe('')
    expect(result.error).toContain('重复')
  }
  expect(m.translate).not.toHaveBeenCalled()
})
it('reuses unchanged partial translation for Final but clears reuse between sessions', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  await r.transcribe({ ...input(), final: false })
  expect(await r.transcribe({ ...input(), revision: 2 })).toMatchObject({ en: 'Hello', zh: '你好' })
  expect(m.translate).toHaveBeenCalledTimes(1)
  r.cancel(token)
  await r.prepare(other)
  await r.transcribe({ ...input(), token: other })
  expect(m.translate).toHaveBeenCalledTimes(2)
})
it('keeps a useful timeout reason instead of a generic translation failure', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.translate.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
  expect((await r.transcribe(input())).error).toContain('超时')
})
it('publishes recognized original before translation completes', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let done!: (text: string) => void
  m.translate.mockImplementationOnce(() => new Promise((resolve) => (done = resolve)))
  await r.prepare(token)
  const recognized: string[] = []
  const job = r.transcribe(input(), (en) => recognized.push(en))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(recognized).toEqual(['Hello'])
  done('你好')
  expect((await job).zh).toBe('你好')
})
it('cancels only a superseded request and leaves the local session usable', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const pending = r.transcribe({ ...input(), final: false })
  r.cancelRequest({ token, id: 0, revision: 1 })
  finish('stale')
  await expect(pending).rejects.toThrow()
  expect(r.active).toBe(true)
  expect(await r.transcribe({ ...input(), revision: 2 })).toMatchObject({ zh: '你好' })
})
it('does not cancel another revision or a stale session when preempting', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const job = r.transcribe(input())
  r.cancelRequest({ token: other, id: 0, revision: 1 })
  r.cancelRequest({ token, id: 0, revision: 2 })
  finish('Hello')
  expect(await job).toMatchObject({ en: 'Hello', zh: '你好' })
})

it('restores clear standalone questions without rewriting embedded questions', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => text)
  await r.prepare(token)
  for (const [en, expected] of [
    [
      'Second, which is the best measure of growth.',
      'Second, which is the best measure of growth?',
    ],
    ['Why are these costs rising.', 'Why are these costs rising?'],
    ['Costs are rising. Why are they rising.', 'Costs are rising. Why are they rising?'],
    ['This explains why these costs are rising.', 'This explains why these costs are rising.'],
    ['What matters is the cost.', 'What matters is the cost.'],
    ['Which is why we need more time.', 'Which is why we need more time.'],
    ['What is needed is more time.', 'What is needed is more time.'],
    ['How is 3.5 calculated.', 'How is 3.5 calculated?'],
    ['Why is this...', 'Why is this...'],
  ]) {
    m.recognize.mockResolvedValueOnce(en)
    expect((await r.transcribe(input())).en).toBe(expected)
  }
})
it('holds an unfinished hard cut, translates its complete prefix and joins only the next window', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Research is costly. Companies invest in pursuit of')
  const held = await r.transcribe({ ...input(), revision: 8, pcm: new Float32Array(192000).buffer })
  expect(held).toMatchObject({ pending: true, zh: '译：Research is costly.' })
  m.recognize.mockResolvedValueOnce('of higher returns.')
  const early = vi.fn()
  const next = await r.transcribe({ ...input(), id: 1, time: 12 }, early)
  expect(next).toMatchObject({
    en: 'Research is costly. Companies invest in pursuit of higher returns.',
    caption: { id: 0, revision: 9, time: 0 },
  })
  expect(next.pending).not.toBe(true)
  expect(early).toHaveBeenCalledWith(
    'Research is costly. Companies invest in pursuit of higher returns.',
    { id: 0, revision: 9, time: 0 },
  )
})
it('does not merge complete sentences, a gap, changed terminology or another session', async () => {
  for (const patch of [{ time: 30 }, { terms: false }, { token: other }]) {
    const m = models(),
      r = new LocalRuntime(m)
    await r.prepare(token)
    m.recognize.mockResolvedValueOnce('Companies invest in pursuit of')
    await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
    if (patch.token) {
      r.cancel(token)
      await r.prepare(other)
    }
    m.recognize.mockResolvedValueOnce('A different topic.')
    const result = await r.transcribe({ ...input(), id: 1, time: 12, ...patch })
    expect(result.en).toBe('A different topic.')
    expect(result.caption).toBeUndefined()
  }
})
it('does not hide a pending original when the continuation is silence or fails translation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Companies invest in pursuit of')
  await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  m.recognize.mockResolvedValueOnce('[BLANK_AUDIO]')
  const empty = await r.transcribe({ ...input(), id: 1, time: 12, final: false })
  expect(empty).toMatchObject({
    en: 'Companies invest in pursuit of',
    pending: true,
    caption: { id: 0 },
  })
  m.recognize.mockResolvedValueOnce('higher returns.')
  m.translate.mockRejectedValueOnce(new Error('failure'))
  const failure = await r.transcribe({ ...input(), id: 1, time: 12, revision: 2 })
  expect(failure.en).toBe('Companies invest in pursuit of higher returns.')
  expect(failure.error).toBeTruthy()
  expect(failure.caption?.id).toBe(0)
})

it('limits continuation to two windows and keeps a still-incomplete joined result unconfirmed', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('We invest in')
  await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  m.recognize.mockResolvedValueOnce('new products for')
  const second = await r.transcribe({
    ...input(),
    id: 1,
    time: 12,
    pcm: new Float32Array(192000).buffer,
  })
  expect(second).toMatchObject({
    pending: true,
    en: 'We invest in new products for',
    caption: { id: 0 },
  })
  m.recognize.mockResolvedValueOnce('A new sentence.')
  const third = await r.transcribe({ ...input(), id: 2, time: 24 })
  expect(third.caption).toBeUndefined()
  expect(third.en).toBe('A new sentence.')
})
it('keeps a completed hard-limit question separate from the following sentence', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('What is this made of?')
  expect(
    (await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })).pending,
  ).toBeUndefined()
  m.recognize.mockResolvedValueOnce('Metal.')
  expect((await r.transcribe({ ...input(), id: 1, time: 12 })).caption).toBeUndefined()
})
it('cannot restore carry state when its translation finishes after cancellation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest in')
  m.translate.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const old = r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  r.cancel(token)
  await r.prepare(other)
  finish('迟到')
  await expect(old).rejects.toThrow()
  m.recognize.mockResolvedValueOnce('Another session.')
  expect(
    (await r.transcribe({ ...input(), id: 1, time: 12, token: other })).caption,
  ).toBeUndefined()
})

it('translates completed sentences while leaving an unfinished trailing clause provisional', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily')
  expect(await r.transcribe({ ...input(), final: false })).toMatchObject({
    pending: true,
    zh: '译：Costs are high.',
  })
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily. Returns increase')
  expect((await r.transcribe({ ...input(), final: false, revision: 2 })).zh).toBe(
    '译：Costs are high.\n译：Companies invest heavily.',
  )
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily. Returns increase.')
  const final = await r.transcribe({ ...input(), revision: 3 })
  expect(final.zh).toBe('译：Costs are high.\n译：Companies invest heavily.\n译：Returns increase.')
  expect(final.pending).toBeUndefined()
})

it('keeps a pause-ended residual clause pending and joins its immediate continuation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Research is costly. Companies invest in pursuit of')
  const held = await r.transcribe({ ...input(), revision: 3, pcm: new Float32Array(64000).buffer })
  expect(held).toMatchObject({ pending: true, zh: '译：Research is costly.' })
  expect(held.error).toBeUndefined()
  m.recognize.mockResolvedValueOnce('higher returns.')
  const next = await r.transcribe({ ...input(), id: 1, time: 4 })
  expect(next).toMatchObject({
    en: 'Research is costly. Companies invest in pursuit of higher returns.',
    zh: '译：Research is costly.\n译：Companies invest in pursuit of higher returns.',
    caption: { id: 0, revision: 4, time: 0 },
  })
  expect(next.pending).toBeUndefined()
})
it('does not send an empty-prefix residual to translation or carry it across a long silence', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('We invest in')
  const held = await r.transcribe({ ...input(), pcm: new Float32Array(32000).buffer })
  expect(held).toMatchObject({ en: 'We invest in', zh: '', pending: true })
  expect(held.error).toBeUndefined()
  expect(m.translate).not.toHaveBeenCalled()
  m.recognize.mockResolvedValueOnce('A different topic.')
  const separate = await r.transcribe({ ...input(), id: 1, time: 10 })
  expect(separate).toMatchObject({ en: 'A different topic.', zh: '译：A different topic.' })
  expect(separate.caption).toBeUndefined()
})

it.each([
  [12, 12],
  [10.48, 10.2],
])(
  'joins a noun-ended unfinished sentence across an audio window ending at %s seconds',
  async (duration, nextStart) => {
    const m = models(),
      r = new LocalRuntime(m)
    m.translate.mockImplementation(async (text: string) => '译：' + text)
    await r.prepare(token)
    m.recognize.mockResolvedValueOnce('It turns out that not all the research projects')
    const first = await r.transcribe({
      ...input(),
      revision: 4,
      pcm: new Float32Array(Math.round(16000 * duration)).buffer,
    })
    expect(first).toMatchObject({
      pending: true,
      zh: '译：It turns out that not all the research projects',
    })
    m.recognize.mockResolvedValueOnce('can be a successful product.')
    const next = await r.transcribe({ ...input(), id: 1, time: nextStart })
    expect(next).toMatchObject({
      en: 'It turns out that not all the research projects can be a successful product.',
      caption: { id: 0, revision: 5 },
    })
    expect(next.pending).toBeUndefined()
  },
)

it('does not mistake an ellipsis for a completed sentence at a window boundary', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('The intensity is the...')
  expect((await r.transcribe(input())).pending).toBe(true)
})

it('publishes provisional Chinese before completion and blocks progress after cancellation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let publish!: (text: string) => void, finish!: (text: string) => void
  m.translate = vi.fn(
    (_text: string, _terms: boolean, _signal: AbortSignal, progress?: (text: string) => void) => {
      publish = progress ?? (() => {})
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
  ) as any
  await r.prepare(token)
  const progress: any[] = []
  const result = r.transcribe(input(), undefined, (value) => progress.push(value)).catch((e) => e)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  publish('你好')
  expect(progress).toEqual([expect.objectContaining({ en: 'Hello', zh: '你好', pending: true })])
  r.cancel(token)
  publish('你好，迟到')
  finish('你好，迟到')
  expect(await result).toBeInstanceOf(Error)
  expect(progress).toHaveLength(1)
})

it('releases ASR acknowledgments while earlier translation remains pending', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let finish!: (text: string) => void
  m.translate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await r.prepare(token)
  const complete = vi.fn()
  expect(await r.recognize(input(), undefined, undefined, complete)).toMatchObject({
    en: 'Hello',
    zh: '',
    pending: true,
  })
  m.recognize.mockResolvedValueOnce('The next sentence.')
  expect(await r.recognize({ ...input(), id: 1, time: 1 })).toMatchObject({
    en: 'The next sentence.',
    pending: true,
  })
  expect(complete).not.toHaveBeenCalled()
  finish('你好')
  await vi.waitFor(() =>
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ en: 'Hello', zh: '你好' })),
  )
})

it('rejects anomalous English before any provisional notification or translation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  const text = 'We have a lot of resources and '.repeat(6).trim()
  m.recognize.mockResolvedValueOnce(text)
  const early = vi.fn(),
    complete = vi.fn()
  const ack = await r.recognize(
    { ...input(), pcm: new Float32Array(160000).buffer },
    early,
    undefined,
    complete,
  )
  expect(early).not.toHaveBeenCalled()
  expect(ack).toMatchObject({ en: '', zh: '', error: expect.stringContaining('重复') })
  expect(m.translate).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

it('establishes continuation during ASR even while its first translation is pending', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (text: string) => void
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest in')
  m.translate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await r.recognize({ ...input(), revision: 4, pcm: new Float32Array(64000).buffer })
  m.recognize.mockResolvedValueOnce('new products.')
  const early = vi.fn(),
    complete = vi.fn()
  const ack = await r.recognize({ ...input(), id: 1, time: 4 }, early, undefined, complete)
  expect(early).toHaveBeenCalledWith('Costs are high. Companies invest in new products.', {
    id: 0,
    revision: 5,
    time: 0,
  })
  expect(ack.caption).toEqual({ id: 0, revision: 5, time: 0 })
  finish('成本很高。')
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  m.recognize.mockResolvedValueOnce('A separate sentence.')
  expect((await r.recognize({ ...input(), id: 2, time: 5 })).caption).toBeUndefined()
})

it('cancels background translation callbacks by exact request and keeps the session usable', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let finish!: (text: string) => void, publish!: (text: string) => void
  m.translate = vi.fn((_en, _terms, _signal, progress) => {
    publish = progress!
    return new Promise((resolve) => {
      finish = resolve
    })
  }) as any
  await r.prepare(token)
  const complete = vi.fn(),
    progress = vi.fn()
  await r.recognize({ ...input(), final: false }, undefined, progress, complete)
  r.cancelRequest({ token, id: 0, revision: 2 })
  publish('你好')
  expect(progress).toHaveBeenCalledOnce()
  r.cancelRequest({ token, id: 0, revision: 1 })
  publish('迟到')
  finish('迟到')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(progress).toHaveBeenCalledOnce()
  expect(complete).not.toHaveBeenCalled()
  expect(r.active).toBe(true)
})

it('distinguishes scheduled translation acknowledgments from terminal no-MT replies', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  expect(await r.recognize(input())).toMatchObject({ translationQueued: true })
  m.recognize.mockResolvedValueOnce('[BLANK_AUDIO]')
  expect(await r.recognize({ ...input(), id: 1, time: 1 })).toEqual({
    en: '',
    zh: '',
    translationQueued: false,
  })
  m.recognize.mockResolvedValueOnce('We invest in')
  expect(await r.recognize({ ...input(), id: 2, time: 2 })).toMatchObject({
    pending: true,
    translationQueued: false,
  })
})

it('does not emit completion twice when the completion consumer throws', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  const complete = vi.fn(() => {
    throw new Error('consumer closed')
  })
  await r.recognize(input(), undefined, undefined, complete)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(complete).toHaveBeenCalledOnce()
})

it('waits for canceled native ASR before marking a resumed session ready', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (text: string) => void
  m.recognize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const old = r.recognize({ ...input(), final: false }).catch((e) => e)
  r.cancel(token)
  const resumed = r.prepare(other)
  await Promise.resolve()
  expect(r.active).toBe(false)
  finish('stale')
  expect(await old).toBeInstanceOf(Error)
  await resumed
  expect(r.active).toBe(true)
  expect(await r.recognize({ ...input(), token: other })).toMatchObject({
    en: 'Hello',
    translationQueued: true,
  })
})

it('reports MT overload through completion without dropping accepted Final requests', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let finish!: (text: string) => void
  m.translate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await r.prepare(token)
  const results: any[] = [],
    overflow = vi.fn()
  for (let id = 0; id < 4; id++) {
    m.recognize.mockResolvedValueOnce(`Sentence ${id}.`)
    expect(
      await r.recognize({ ...input(), id, time: id }, undefined, undefined, (result) =>
        results.push(result),
      ),
    ).toMatchObject({ translationQueued: true })
  }
  m.recognize.mockResolvedValueOnce('Overflow sentence.')
  await r.recognize({ ...input(), id: 4, time: 4 }, undefined, undefined, overflow)
  await vi.waitFor(() =>
    expect(overflow).toHaveBeenCalledWith(
      expect.objectContaining({
        en: 'Overflow sentence.',
        zh: '',
        error: expect.stringContaining('积压'),
      }),
    ),
  )
  expect(results).toHaveLength(0)
  finish('第一句。')
  await vi.waitFor(() => expect(results).toHaveLength(4))
  expect(results.map((result) => result.en)).toEqual([
    'Sentence 0.',
    'Sentence 1.',
    'Sentence 2.',
    'Sentence 3.',
  ])
})

it('blocks old-session MT progress and completion after cancel and prepare', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let finish!: (text: string) => void, publish!: (text: string) => void
  m.translate = vi.fn((_en, _terms, _signal, progress) => {
    publish = progress!
    return new Promise((resolve) => {
      finish = resolve
    })
  }) as any
  await r.prepare(token)
  const progress = vi.fn(),
    complete = vi.fn()
  await r.recognize(input(), undefined, progress, complete)
  r.cancel(token)
  await r.prepare(other)
  publish('旧会话')
  finish('旧会话')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(progress).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
  m.translate.mockResolvedValueOnce('新会话')
  expect(await r.transcribe({ ...input(), token: other })).toMatchObject({ zh: '新会话' })
})

it('reuses completed sentence translations when ASR adds a new sentence', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Costs are high.')
  await r.transcribe({ ...input(), final: false })
  m.recognize.mockResolvedValueOnce('Costs are high. Returns rise.')
  expect(await r.transcribe({ ...input(), revision: 2 })).toMatchObject({
    zh: '译：Costs are high.\n译：Returns rise.',
  })
  expect(m.translate.mock.calls.map((call) => call[0])).toEqual([
    'Costs are high.',
    'Returns rise.',
  ])
})

it('lets an unchanged Final reuse an in-flight Partial translation without restarting the model', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.recognize.mockResolvedValue('Costs are high.')
  let release!: (zh: string) => void
  let nativeSignal!: AbortSignal
  m.translate.mockImplementationOnce((_en: string, _terms: boolean, signal: AbortSignal) => {
    nativeSignal = signal
    return new Promise<string>((resolve) => {
      release = resolve
    })
  })
  await r.prepare(token)
  const partialResults: any[] = [],
    finalResults: any[] = []
  await r.recognize({ ...input(), final: false }, undefined, undefined, (x) =>
    partialResults.push(x),
  )
  await r.recognize({ ...input(), revision: 2 }, undefined, undefined, (x) => finalResults.push(x))
  expect(nativeSignal.aborted).toBe(false)
  release('成本很高。')
  await vi.waitFor(() => expect(finalResults).toHaveLength(1))
  expect(partialResults).toHaveLength(1)
  expect(finalResults[0]).toMatchObject({ en: 'Costs are high.', zh: '成本很高。' })
  expect(m.translate).toHaveBeenCalledTimes(1)
})

it.each(['words', 'terms'] as const)(
  'still preempts a Partial when Final changes %s',
  async (change) => {
    const m = models(),
      r = new LocalRuntime(m)
    m.recognize
      .mockResolvedValueOnce('Costs are high.')
      .mockResolvedValueOnce(change === 'words' ? 'Costs are low.' : 'Costs are high.')
    let release!: (zh: string) => void
    let oldSignal!: AbortSignal
    m.translate.mockImplementationOnce((_en: string, _terms: boolean, signal: AbortSignal) => {
      oldSignal = signal
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    await r.prepare(token)
    await r.recognize({ ...input(), final: false })
    const results: any[] = []
    await r.recognize(
      { ...input(), revision: 2, terms: change === 'terms' ? false : true },
      undefined,
      undefined,
      (x) => results.push(x),
    )
    expect(oldSignal.aborted).toBe(true)
    release('旧结果')
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].zh).toBe('你好')
    expect(m.translate).toHaveBeenCalledTimes(2)
  },
)

it('retries the Final if its same-source in-flight Partial translation fails', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.recognize.mockResolvedValue('Costs are high.')
  let fail!: (e: Error) => void
  m.translate.mockImplementationOnce(
    () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject
      }),
  )
  await r.prepare(token)
  const partial: any[] = [],
    final: any[] = []
  await r.recognize({ ...input(), final: false }, undefined, undefined, (x) => partial.push(x))
  await r.recognize({ ...input(), revision: 2 }, undefined, undefined, (x) => final.push(x))
  fail(new Error('transient model failure'))
  await vi.waitFor(() => expect(final).toHaveLength(1))
  expect(partial[0].error).toContain('失败')
  expect(final[0]).toMatchObject({ en: 'Costs are high.', zh: '你好' })
  expect(final[0].error).toBeUndefined()
  expect(m.translate).toHaveBeenCalledTimes(2)
})

it('uses the same safe quoted sentence prefix in the runtime without translating the open tail', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.recognize.mockResolvedValue('He said "Ready." Now the')
  await r.prepare(token)
  expect(await r.transcribe(input())).toMatchObject({
    en: 'He said "Ready." Now the',
    pending: true,
  })
  expect(m.translate).toHaveBeenCalledWith(
    'He said "Ready."',
    true,
    expect.any(AbortSignal),
    expect.any(Function),
  )
})

it('notifies completed sentence units while a following sentence is still pending', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.recognize.mockResolvedValue('Costs are high. Returns rise. Growth continues.')
  let release!: (zh: string) => void
  m.translate.mockImplementation(async (text: string) =>
    text === 'Growth continues.'
      ? new Promise<string>((resolve) => {
          release = resolve
        })
      : '译:' + text,
  )
  await r.prepare(token)
  const progress: any[] = []
  await r.recognize(input(), undefined, (x) => progress.push(x))
  await vi.waitFor(() => expect(progress.at(-1)?.units).toHaveLength(2))
  expect(progress.at(-1).units[1]).toMatchObject({
    source: 'Returns rise.',
    zh: '译:Returns rise.',
  })
  release('增长继续。')
})

it('traces stages without depending on the diagnostics observer succeeding', async () => {
  const m = models(),
    events: string[] = []
  m.recognize.mockResolvedValue('Costs are high.')
  const r = new LocalRuntime(m, (_key, stage) => {
    events.push(stage)
    if (stage === 'asrStart') throw new Error('diagnostics unavailable')
  })
  await r.prepare(token)
  expect((await r.transcribe(input())).zh).toBe('你好')
  expect(events).toEqual(
    expect.arrayContaining([
      'asrStart',
      'asrEnd',
      'qualityEnd',
      'englishNotified',
      'mtQueued',
      'mtStart',
      'mtFirst',
      'mtUnit',
      'complete',
    ]),
  )
})
