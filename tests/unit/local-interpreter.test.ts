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
