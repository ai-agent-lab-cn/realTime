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

it('delivers Chinese while the local HTTP translation is still generating', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream))
  const progress: string[] = []
  const result = new NativeModels('/unused')
    .translate('Costs are high.', false, new AbortController().signal, (text) =>
      progress.push(text),
    )
    .catch((e) => e)
  const send = (s: string) => controller.enqueue(new TextEncoder().encode(s))
  try {
    const data =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: '成本很高' }, finish_reason: null }] }) +
      '\r\n\r\n'
    const bytes = new TextEncoder().encode(data)
    // Split inside the multi-byte Chinese payload, as real transport chunks can do.
    const cut = bytes.indexOf(0xe6) + 1
    controller.enqueue(bytes.slice(0, cut))
    controller.enqueue(bytes.slice(cut))
    await vi.waitFor(() => expect(progress).toEqual(['成本很高']))
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).stream).toBe(true)
    send(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] }) +
        '\n\ndata: [DONE]\n\n',
    )
    controller.close()
    expect(await result).toBe('成本很高。')
  } finally {
    fetch.mockRestore()
    try {
      controller.close()
    } catch {}
  }
})

it.each(['length', null])('rejects a truncated translation stream (%s)', async (reason) => {
  const body =
    'data: ' +
    JSON.stringify({ choices: [{ delta: { content: '没有完成' }, finish_reason: reason }] }) +
    '\n\ndata: [DONE]\n\n'
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
  try {
    await expect(
      new NativeModels('/unused').translate('Incomplete', false, new AbortController().signal),
    ).rejects.toThrow()
  } finally {
    fetch.mockRestore()
  }
})

it('cancels a stalled translation stream without waiting for the response to finish', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream))
  const signal = new AbortController(),
    progress: string[] = []
  const job = new NativeModels('/unused')
    .translate('Test', false, signal.signal, (text) => progress.push(text))
    .catch((e) => e)
  try {
    controller.enqueue(
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"初步"},"finish_reason":null}]}\n\n',
      ),
    )
    await vi.waitFor(() => expect(progress).toEqual(['初步']))
    signal.abort()
    expect(await job).toBeInstanceOf(Error)
    expect(progress).toEqual(['初步'])
  } finally {
    fetch.mockRestore()
  }
})
