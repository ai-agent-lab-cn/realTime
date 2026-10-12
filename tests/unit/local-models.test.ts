import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
vi.mock('node:fs/promises', () => ({ access: vi.fn(async () => {}) }))
import { NativeModels } from '../../electron/local-models'
it('fails readiness if ASR exits while translation is still loading', async () => {
  const children: any[] = []
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
    })
    child.kill.mockImplementation((signal: string) => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    children.push(child)
    return child
  })
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (url) => new Response('', { status: String(url).split('/').length > 4 ? 200 : 503 }),
    )
  const runtime = new NativeModels('/unused')
  try {
    const result = runtime.prepare().then(
      () => 'ready',
      () => 'failed',
    )
    await vi.waitFor(() => expect(children).toHaveLength(2), { interval: 5 })
    children[0].exitCode = 1
    children[0].emit('exit', 1, null)
    fetch.mockResolvedValue(new Response('', { status: 200 }))
    expect(await result).toBe('failed')
  } finally {
    runtime.close()
    fetch.mockRestore()
  }
})
it('does not inject software vocabulary into course recognition when terminology is enabled', async () => {
  const calls: FormData[] = []
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    calls.push(options!.body as FormData)
    return new Response(JSON.stringify({ text: 'Research and development.' }), { status: 200 })
  })
  try {
    const models = new NativeModels('/unused')
    await models.recognize(new Float32Array(16000).buffer, true, new AbortController().signal)
    expect(calls[0].get('prompt')).toBe('')
  } finally {
    request.mockRestore()
  }
})
