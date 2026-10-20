import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
// @ts-expect-error Independent experimental ESM helper.
import { JsonWorker } from '../../scripts/local/streaming-asr/worker.mjs'

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  return child
}

function observe(promise: Promise<unknown>) {
  const result: { error?: Error; value?: unknown } = {}
  promise.then(value => { result.value = value }, error => { result.error = error })
  return result
}

afterEach(() => vi.useRealTimers())

it('bounds a write that never drains and clears its timeout', async () => {
  vi.useFakeTimers()
  const child = childFixture()
  const worker = new JsonWorker(child, undefined, 50)
  const result = observe(worker.send({ type: 'audio' }))
  await vi.advanceTimersByTimeAsync(50)
  expect(result.error?.message).toMatch(/drain.*timeout|timeout.*drain/i)
  expect(vi.getTimerCount()).toBe(0)
  expect(child.stdin.listenerCount('drain')).toBe(0)
})

it('parent cancellation interrupts both backpressure and a pending response', async () => {
  vi.useFakeTimers()
  const child = childFixture(), controller = new AbortController()
  const worker = new JsonWorker(child, controller.signal)
  const sent = observe(worker.send({ type: 'audio' }))
  const response = observe(worker.wait((e: { type: string }) => e.type === 'complete'))
  controller.abort(new Error('Experiment cancelled'))
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.error?.message).toMatch(/cancelled/i)
  expect(response.error?.message).toMatch(/cancelled/i)
  expect(vi.getTimerCount()).toBe(0)
  expect(child.stdin.listenerCount('drain')).toBe(0)
})

it('child exit interrupts sends and responses without waiting for their timers', async () => {
  vi.useFakeTimers()
  const child = childFixture(), worker = new JsonWorker(child)
  const sent = observe(worker.send({ type: 'audio' }))
  const response = observe(worker.wait(() => true))
  child.emit('exit', 2, null)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.error?.message).toMatch(/exited 2/i)
  expect(response.error?.message).toMatch(/exited 2/i)
  expect(vi.getTimerCount()).toBe(0)
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.stdin.listenerCount('drain')).toBe(0)
})

it('handles asynchronous stdin EPIPE and rejects all waiting operations', async () => {
  vi.useFakeTimers()
  const child = childFixture(), worker = new JsonWorker(child)
  const sent = observe(worker.send({ type: 'audio' }))
  const response = observe(worker.wait(() => true))
  expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow()
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.error?.message).toMatch(/EPIPE/)
  expect(response.error?.message).toMatch(/EPIPE/)
  expect(vi.getTimerCount()).toBe(0)
})

it('child process error interrupts a pending drain', async () => {
  vi.useFakeTimers()
  const child = childFixture(), worker = new JsonWorker(child)
  const sent = observe(worker.send({ type: 'audio' }))
  child.emit('error', new Error('spawn failed'))
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.error?.message).toMatch(/spawn failed/)
  expect(vi.getTimerCount()).toBe(0)
})

it('returns JSON responses and releases response timers normally', async () => {
  vi.useFakeTimers()
  const child = childFixture(), worker = new JsonWorker(child)
  const response = worker.wait((e: { type: string }) => e.type === 'ready')
  child.stdout.write('{"type":"ready"}\n')
  await expect(response).resolves.toEqual({ type: 'ready' })
  expect(vi.getTimerCount()).toBe(0)
  child.emit('exit', 0, null)
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
})

it('fails closed when more than 4096 unconsumed JSON events accumulate', async () => {
  const child = childFixture(), worker = new JsonWorker(child)
  for (let i = 0; i < 4097; i++) child.stdout.write('{"type":"partial"}\n')
  expect(worker.events.length).toBeLessThanOrEqual(4096)
  await expect(worker.wait(() => true)).rejects.toThrow(/queue|4096/i)
})

it('keeps at most 12000 bytes of stderr diagnostics', () => {
  const child = childFixture(), worker = new JsonWorker(child)
  child.stderr.write('中'.repeat(12000))
  expect(Buffer.byteLength(worker.stderr)).toBeLessThanOrEqual(12000)
  expect(worker.stderr.endsWith('中')).toBe(true)
  child.emit('exit', 0, null)
})

it('removes lifecycle listeners after process and stream closure', async () => {
  vi.useFakeTimers()
  const child = childFixture(), controller = new AbortController()
  const worker = new JsonWorker(child, controller.signal)
  const sent = observe(worker.send({ type: 'audio' }))
  child.emit('exit', 0, null)
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  child.emit('close', 0, null)
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.error).toBeInstanceOf(Error)
  expect(vi.getTimerCount()).toBe(0)
  for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
    for (const event of ['error', 'drain', 'exit', 'data', 'close']) {
      expect(emitter.listenerCount(event)).toBe(0)
    }
  }
})
