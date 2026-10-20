import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInterpreter } from '../../src/stores/interpreter'
import { useLocalInterpreter } from '../../src/composables/useLocalInterpreter'
import { MicrophoneCapture } from '../../src/audio/microphone'
import type { LocalTranscript } from '../../electron/local-types'

let samples!: (pcm: Float32Array, rate: number) => void
let ended!: () => void
let stopCapture!: ReturnType<typeof vi.fn>
let bridge: {
  prepare: ReturnType<typeof vi.fn>
  transcribe: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  bridge = {
    prepare: vi.fn(async () => {}),
    transcribe: vi.fn(async (): Promise<LocalTranscript> => ({ en: 'Hello', zh: '你好' })),
    cancel: vi.fn(async () => {}),
  }
  vi.stubGlobal('window', { desktop: { local: bridge } })
  setActivePinia(createPinia())
  stopCapture = vi.fn()
  vi.spyOn(MicrophoneCapture, 'start').mockImplementation(async (onSamples, onEnded) => {
    samples = onSamples
    ended = onEnded
    return { stop: stopCapture } as unknown as MicrophoneCapture
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('local interpreter lifecycle', () => {
  it('keeps Ready and offers retry after microphone permission is denied', async () => {
    vi.spyOn(MicrophoneCapture, 'start').mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    )
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    await local.begin()
    expect(store.session.status).toBe('Ready')
    expect(local.error.value).toContain('麦克风权限被拒绝')
    await local.begin()
    expect(store.session.status).toBe('Listening')
    local.stop()
  })

  it('keeps Ready until preparation and microphone finish, and cancellation ignores late preparation', async () => {
    let finish!: () => void
    bridge.prepare.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    const starting = local.begin()
    expect(store.session.status).toBe('Ready')
    expect(local.busy.value).toBe(true)
    local.cancelPreparing()
    finish()
    await starting
    expect(store.session.status).toBe('Ready')
    expect(local.busy.value).toBe(false)
  })

  it('shows a final subtitle from captured samples, then freezes on device loss', async () => {
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    await local.begin()
    expect(store.session.status).toBe('Listening')
    samples(new Float32Array(16000 * 2).fill(0.1), 16000)
    samples(new Float32Array(16000).fill(0), 16000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.session.captions.at(-1)).toMatchObject({ en: 'Hello', zh: '你好', final: true })
    ended()
    expect(store.session.status).toBe('Paused')
    expect(local.error.value).toContain('麦克风已断开')
  })

  it('retains a failed translation with its reason and continues listening', async () => {
    bridge.transcribe.mockResolvedValue({ en: 'Hello', zh: '', error: 'translation failed' })
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    await local.begin()
    samples(new Float32Array(16000 * 2).fill(0.1), 16000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.session.captions.at(-1)).toMatchObject({ en: 'Hello', final: false })
    expect(store.session.status).toBe('Listening')
    expect(store.session.captions.at(-1)?.error).toContain('translation failed')
  })

  it('ignores a native result that finishes after stopping', async () => {
    let finish!: (result: LocalTranscript) => void
    bridge.transcribe.mockImplementation(
      () => new Promise<LocalTranscript>((resolve) => (finish = resolve)),
    )
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    await local.begin()
    samples(new Float32Array(16000 * 2).fill(0.1), 16000)
    local.stop()
    finish({ en: 'Late', zh: '迟到' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.session.status).toBe('Stopped')
    expect(store.session.captions).toEqual([])
  })

  it('ignores an old microphone end callback after resuming with a new device session', async () => {
    const store = useInterpreter()
    const local = useLocalInterpreter(store)
    await local.begin()
    const staleEnded = ended
    local.pause()
    await local.begin(true)
    staleEnded()
    expect(store.session.status).toBe('Listening')
    expect(local.error.value).toBe('')
    local.stop()
  })
})

it('pauses visibly after three failing segments rather than counting Partial revisions', async () => {
  bridge.transcribe.mockResolvedValue({ en: 'Hello', zh: '', error: '翻译服务超时' })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  for (let i = 0; i < 3; i++) {
    samples(new Float32Array(16000 * 2).fill(0.1), 16000)
    samples(new Float32Array(16000), 16000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (i < 2) expect(store.session.status).toBe('Listening')
  }
  expect(store.session.status).toBe('Paused')
  expect(local.error.value).toContain('已自动暂停')
  expect(local.error.value).toContain('翻译服务超时')
  expect(store.session.captions).toHaveLength(3)
})
it('leaves a visible unconfirmed gap when repeated ASR is quarantined', async () => {
  bridge.transcribe.mockResolvedValue({ en: '', zh: '', error: '识别出现异常重复，本段未确认' })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(16000 * 2).fill(0.1), 16000)
  samples(new Float32Array(16000), 16000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store.session.captions.at(-1)).toMatchObject({
    final: false,
    error: expect.stringContaining('重复'),
  })
  expect(store.session.status).toBe('Listening')
  local.stop()
})
it('replaces a failed partial with a successful Final and clears its warning', async () => {
  bridge.transcribe.mockResolvedValueOnce({ en: 'Hello', zh: '', error: 'temporary failure' })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(16000 * 2).fill(0.1), 16000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store.session.captions[0]?.error).toBe('temporary failure')
  samples(new Float32Array(16000), 16000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store.session.captions[0]).toMatchObject({ final: true, zh: '你好' })
  expect(store.session.captions[0]?.error).toBeUndefined()
  local.stop()
})
it('shows early original, completes the same revision with translation and ignores late events', async () => {
  let recognized!: (value: any) => void
  const unsubscribe = vi.fn()
  Object.assign(bridge, {
    onRecognized: (callback: typeof recognized) => {
      recognized = callback
      return unsubscribe
    },
  })
  let finish!: (value: LocalTranscript) => void
  bridge.transcribe.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(16000 * 2).fill(0.1), 16000)
  const req = bridge.transcribe.mock.calls[0][0]
  expect(typeof recognized).toBe('function')
  recognized({ ...req, en: 'Hello' })
  expect(store.session.captions[0]).toMatchObject({ en: 'Hello', zh: '', final: false })
  finish({ en: 'Hello', zh: '你好' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store.session.captions[0]).toMatchObject({ en: 'Hello', zh: '你好' })
  local.pause()
  recognized({ ...req, revision: 99, en: 'Stale' })
  expect(store.session.captions[0]?.en).toBe('Hello')
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('waiting for continuation does not count as a translation failure or trigger automatic pause', async () => {
  bridge.transcribe.mockResolvedValue({ en: 'In pursuit of', zh: '', pending: true })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  for (let i = 0; i < 3; i++) {
    samples(new Float32Array(32000).fill(0.1), 16000)
    samples(new Float32Array(16000), 16000)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(store.session.status).toBe('Listening')
  expect(local.error.value).toBe('')
  expect(store.session.captions.every((c) => !c.final)).toBe(true)
  local.stop()
})

it('updates Chinese during generation, confirms only on completion and ignores stale progress', async () => {
  let progress!: (value: any) => void
  const unsubscribe = vi.fn()
  Object.assign(bridge, {
    onTranslated: (callback: typeof progress) => {
      progress = callback
      return unsubscribe
    },
  })
  let finish!: (value: LocalTranscript) => void
  bridge.transcribe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  const req = bridge.transcribe.mock.calls[0][0]
  expect(progress).toBeTypeOf('function')
  progress({ ...req, en: 'Costs are high.', zh: '成本', pending: true })
  progress({ ...req, en: 'Costs are high.', zh: '成本很高', pending: true })
  expect(store.session.captions[0]).toMatchObject({ zh: '成本很高', final: false })
  finish({ en: 'Costs are high.', zh: '成本很高。' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  progress({ ...req, en: 'Costs are high.', zh: '迟到', pending: true })
  expect(store.session.captions[0].zh).toBe('成本很高。')
  local.pause()
  progress({ ...req, en: 'Costs are high.', zh: '暂停后', pending: true })
  expect(store.session.captions[0].zh).toBe('成本很高。')
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('routes streamed continuation to the original caption and keeps Final immutable', async () => {
  let progress!: (value: any) => void
  Object.assign(bridge, {
    onTranslated: (callback: typeof progress) => {
      progress = callback
      return () => {}
    },
  })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  bridge.transcribe.mockImplementation(async (req) => {
    if (req.id === 0) return { en: 'The projects', zh: '项目', pending: true }
    const caption = { id: 0, revision: 10 + req.revision, time: 0 }
    progress({ ...req, en: 'The projects succeed.', zh: '项目成功', pending: true, caption })
    expect(store.session.captions).toHaveLength(1)
    expect(store.session.captions[0]).toMatchObject({ zh: '项目成功', final: false })
    return { en: 'The projects succeed.', zh: '项目成功。', caption }
  })
  await local.begin()
  // Feed two short windows through the real segmenter and queue.
  samples(new Float32Array(8000).fill(0.1), 16000)
  samples(new Float32Array(24000), 16000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  samples(new Float32Array(8000).fill(0.1), 16000)
  samples(new Float32Array(24000), 16000)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(store.session.captions).toHaveLength(1)
  expect(store.session.captions[0]).toMatchObject({ zh: '项目成功。', final: true })
  local.stop()
})

it('continues showing translation when a streamed terminology token becomes normalized', async () => {
  let progress!: (value: any) => void, finish!: (value: LocalTranscript) => void
  Object.assign(bridge, {
    onTranslated: (callback: typeof progress) => {
      progress = callback
      return () => {}
    },
  })
  bridge.transcribe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  const req = bridge.transcribe.mock.calls[0][0]
  progress({ ...req, en: 'Use a pull request.', zh: '使用 pull', pending: true })
  progress({ ...req, en: 'Use a pull request.', zh: '使用 Pull Request 提交变更', pending: true })
  expect(store.session.captions[0].zh).toBe('使用 Pull Request 提交变更')
  local.stop()
  finish({ en: 'Use a pull request.', zh: '迟到结果' })
})

function pipelineBridge() {
  let recognized!: (value: any) => void
  let translated!: (value: any) => void
  const recognize = vi.fn(async (): Promise<LocalTranscript> => ({ en: 'Costs are high.', zh: '' }))
  Object.assign(bridge, {
    recognize,
    onRecognized: (callback: typeof recognized) => {
      recognized = callback
      return () => {}
    },
    onTranslated: (callback: typeof translated) => {
      translated = callback
      return () => {}
    },
  })
  return {
    recognize,
    recognized: (value: any) => recognized(value),
    translated: (value: any) => translated(value),
  }
}
const flushPipeline = () => new Promise((resolve) => setTimeout(resolve, 0))

it('releases ASR on its acknowledgement and updates English even while prior Chinese remains visible', async () => {
  const pipeline = pipelineBridge()
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  await flushPipeline()
  expect(pipeline.recognize.mock.calls).toHaveLength(1)
  const first = pipeline.recognize.mock.calls[0][0]
  pipeline.translated({
    ...first,
    en: 'Costs are high.',
    zh: '成本很高。',
    phase: 'complete',
    audioFinal: false,
  })
  pipeline.recognize.mockImplementation(() => new Promise(() => {}))
  samples(new Float32Array(16000).fill(0.1), 16000)
  await flushPipeline()
  expect(pipeline.recognize.mock.calls.length).toBeGreaterThan(1)
  const next = pipeline.recognize.mock.calls.at(-1)![0]
  pipeline.recognized({ ...next, en: 'Costs are high. Returns rise.' })
  expect(store.session.captions[0]).toMatchObject({
    en: 'Costs are high. Returns rise.',
    zh: '成本很高。',
    final: false,
  })
  pipeline.translated({
    ...first,
    en: 'Costs are high.',
    zh: '成本很高。',
    phase: 'complete',
    audioFinal: false,
  })
  expect(store.session.captions[0].en).toBe('Costs are high. Returns rise.')
  local.stop()
})

it('counts asynchronous final MT failures once per window and ignores pending acknowledgements', async () => {
  const pipeline = pipelineBridge()
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  const finals: any[] = []
  for (let i = 0; i < 3; i++) {
    samples(new Float32Array(32000).fill(0.1), 16000)
    samples(new Float32Array(16000), 16000)
    await flushPipeline()
    const request = pipeline.recognize.mock.calls
      .map((call) => call[0])
      .find((req: any) => req.id === i && req.final)
    expect(request).toBeDefined()
    finals.push(request)
    expect(store.session.status).toBe('Listening')
  }
  // Completion order must not turn unknown outcomes into successful windows.
  for (const request of [finals[2], finals[0], finals[1]]) {
    pipeline.translated({
      ...request,
      en: 'Costs are high.',
      zh: '',
      error: '翻译超时',
      phase: 'complete',
      audioFinal: true,
    })
    pipeline.translated({
      ...request,
      en: 'Costs are high.',
      zh: '',
      error: '翻译超时',
      phase: 'complete',
      audioFinal: true,
    })
  }
  expect(store.session.status).toBe('Paused')
  expect(local.error.value).toContain('连续三段')
})

it('routes pipeline carry without a second row and rejects old notifications after pause and resume', async () => {
  const pipeline = pipelineBridge()
  pipeline.recognize.mockImplementation(async (request: any) => ({
    en: request.id ? 'The projects succeed.' : 'The projects',
    zh: '',
    pending: !request.id,
    ...(request.id ? { caption: { id: 0, revision: 10 + request.revision, time: 0 } } : {}),
  }))
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  for (let i = 0; i < 2; i++) {
    samples(new Float32Array(8000).fill(0.1), 16000)
    samples(new Float32Array(24000), 16000)
    await flushPipeline()
  }
  const request = pipeline.recognize.mock.calls.at(-1)![0]
  pipeline.translated({
    ...request,
    caption: { id: 0, revision: 10 + request.revision, time: 0 },
    en: 'The projects succeed.',
    zh: '项目成功。',
    phase: 'complete',
    audioFinal: true,
  })
  expect(store.session.captions).toHaveLength(1)
  expect(store.session.captions[0]).toMatchObject({ final: true, zh: '项目成功。' })
  local.pause()
  await local.begin(true)
  pipeline.translated({ ...request, en: 'Stale', zh: '过期', phase: 'complete', audioFinal: true })
  expect(store.session.captions[0].zh).toBe('项目成功。')
  local.stop()
})

it('does not let a continuation-only final window block later asynchronous failures', async () => {
  const pipeline = pipelineBridge()
  pipeline.recognize.mockImplementation(async (request: any) => ({
    en: request.id === 0 ? 'In pursuit of' : 'Hello.',
    zh: '',
    pending: true,
    translationQueued: request.id !== 0,
  }))
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  for (let i = 0; i < 4; i++) {
    samples(new Float32Array(8000).fill(0.1), 16000)
    samples(new Float32Array(24000), 16000)
    await flushPipeline()
    const request = pipeline.recognize.mock.calls.at(-1)![0]
    if (i > 0)
      pipeline.translated({
        ...request,
        en: 'Hello.',
        zh: '',
        error: '翻译失败',
        phase: 'complete',
        audioFinal: true,
      })
  }
  expect(store.session.status).toBe('Paused')
  expect(local.error.value).toContain('连续三段')
})

it('immediately pauses on asynchronous MT overload and freezes all late pipeline callbacks', async () => {
  const pipeline = pipelineBridge()
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  await flushPipeline()
  const request = pipeline.recognize.mock.calls[0][0]
  pipeline.translated({
    ...request,
    en: 'Costs are high.',
    zh: '',
    error: '本地翻译持续积压',
    phase: 'complete',
    audioFinal: false,
  })
  expect(store.session.status).toBe('Paused')
  expect(local.error.value).toContain('积压')
  const frozen = JSON.stringify(store.session.captions)
  pipeline.recognized({ ...request, revision: 99, en: 'Late' })
  pipeline.translated({ ...request, en: 'Late', zh: '迟到', phase: 'complete', audioFinal: true })
  expect(JSON.stringify(store.session.captions)).toBe(frozen)
})

it('releases completed pipeline request metadata so duplicate callbacks cannot trigger a late pause', async () => {
  const pipeline = pipelineBridge()
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  await flushPipeline()
  const request = pipeline.recognize.mock.calls[0][0]
  pipeline.translated({
    ...request,
    en: 'Costs are high.',
    zh: '成本很高。',
    phase: 'complete',
    audioFinal: false,
  })
  pipeline.translated({
    ...request,
    en: 'Costs are high.',
    zh: '',
    error: '重复旧请求积压',
    phase: 'complete',
    audioFinal: false,
  })
  expect(store.session.status).toBe('Listening')
  expect(store.session.captions[0]).toMatchObject({
    zh: '成本很高。',
    error: undefined,
    final: false,
  })
  local.stop()
})

it('keeps submitting new ASR snapshots while no MT notification has completed', async () => {
  const pipeline = pipelineBridge()
  pipeline.recognize.mockResolvedValue({
    en: 'Still speaking.',
    zh: '',
    pending: true,
    translationQueued: true,
  })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  await flushPipeline()
  samples(new Float32Array(16000).fill(0.1), 16000)
  await flushPipeline()
  expect(pipeline.recognize.mock.calls.length).toBeGreaterThan(1)
  expect(bridge.transcribe).not.toHaveBeenCalled()
  expect(store.session.captions[0]).toMatchObject({ en: 'Still speaking.', zh: '', final: false })
  local.stop()
})

it('prunes obsolete acked Partial routes when a later audio Final completes', async () => {
  const pipeline = pipelineBridge()
  pipeline.recognize.mockResolvedValue({
    en: 'Costs are high.',
    zh: '',
    pending: true,
    translationQueued: true,
  })
  const store = useInterpreter(),
    local = useLocalInterpreter(store)
  await local.begin()
  samples(new Float32Array(32000).fill(0.1), 16000)
  await flushPipeline()
  const partial = pipeline.recognize.mock.calls[0][0]
  expect(partial.final).toBe(false)
  samples(new Float32Array(16000), 16000)
  await flushPipeline()
  const finalized = pipeline.recognize.mock.calls.at(-1)![0]
  expect(finalized.final).toBe(true)
  pipeline.translated({
    ...finalized,
    en: 'Costs are high.',
    zh: '成本很高。',
    phase: 'complete',
    audioFinal: true,
  })
  const frozen = JSON.stringify(store.session.captions)
  pipeline.translated({
    ...partial,
    en: 'Costs are high.',
    zh: '',
    error: '旧 Partial 已积压',
    phase: 'complete',
    audioFinal: false,
  })
  expect(store.session.status).toBe('Listening')
  expect(JSON.stringify(store.session.captions)).toBe(frozen)
  local.stop()
})
