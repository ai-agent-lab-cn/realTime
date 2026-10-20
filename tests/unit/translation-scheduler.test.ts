import { expect, it } from 'vitest'
import { TranslationScheduler } from '../../electron/translation-scheduler'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const signal = () => new AbortController().signal

it('runs only one native translation and coalesces pending Partial for the same caption', async () => {
  const scheduler = new TranslationScheduler()
  const gate = deferred<string>()
  const order: string[] = []
  const active = scheduler.run('a', false, signal(), async () => {
    order.push('a')
    return gate.promise
  })
  const stale = scheduler
    .run('b', false, signal(), async () => {
      order.push('stale')
      return 'stale'
    })
    .catch((e) => e)
  const latest = scheduler.run('b', false, signal(), async () => {
    order.push('latest')
    return 'new'
  })
  expect(order).toEqual(['a'])
  expect(await stale).toBeInstanceOf(Error)
  gate.resolve('first')
  expect(await active).toBe('first')
  expect(await latest).toBe('new')
  expect(order).toEqual(['a', 'latest'])
})

it('preempts a same-caption Partial for Final but waits for aborted native work to settle', async () => {
  const scheduler = new TranslationScheduler()
  const gate = deferred<string>()
  let nativeSignal!: AbortSignal
  const order: string[] = []
  const partial = scheduler
    .run('a', false, signal(), async (s) => {
      nativeSignal = s
      order.push('partial')
      return gate.promise
    })
    .catch((e) => e)
  const final = scheduler.run('a', true, signal(), async () => {
    order.push('final')
    return 'done'
  })
  expect(nativeSignal.aborted).toBe(true)
  expect(await partial).toBeInstanceOf(Error)
  expect(order).toEqual(['partial'])
  gate.resolve('late')
  expect(await final).toBe('done')
  expect(order).toEqual(['partial', 'final'])
})

it('retains all three waiting Finals and reports overload explicitly', async () => {
  const scheduler = new TranslationScheduler()
  const gate = deferred<string>()
  const active = scheduler.run('active', true, signal(), () => gate.promise)
  const order: number[] = []
  const finals = [1, 2, 3].map((n) =>
    scheduler.run(String(n), true, signal(), async () => {
      order.push(n)
      return n
    }),
  )
  await expect(scheduler.run('overflow', true, signal(), async () => 4)).rejects.toThrow('积压')
  gate.resolve('done')
  await active
  expect(await Promise.all(finals)).toEqual([1, 2, 3])
  expect(order).toEqual([1, 2, 3])
})

it('removes canceled queued work and serializes a new session behind an aborted native job', async () => {
  const scheduler = new TranslationScheduler()
  const gate = deferred<string>()
  const old = new AbortController(),
    queued = new AbortController()
  const order: string[] = []
  const active = scheduler.run('old:0', true, old.signal, () => gate.promise).catch((e) => e)
  const canceled = scheduler
    .run('old:1', true, queued.signal, async () => {
      order.push('canceled')
      return ''
    })
    .catch((e) => e)
  queued.abort()
  old.abort()
  const next = scheduler.run('new:0', true, signal(), async () => {
    order.push('new')
    return 'new'
  })
  expect(await canceled).toBeInstanceOf(Error)
  expect(await active).toBeInstanceOf(Error)
  expect(order).toEqual([])
  gate.resolve('late')
  expect(await next).toBe('new')
  expect(order).toEqual(['new'])
})

it('bounds speculative work to the latest pending Partial across different captions', async () => {
  const scheduler = new TranslationScheduler()
  const gate = deferred<string>()
  const active = scheduler.run('active', true, signal(), () => gate.promise)
  const order: string[] = []
  const stale = scheduler
    .run('old-caption', false, signal(), async () => {
      order.push('stale')
      return ''
    })
    .catch((e) => e)
  const final = scheduler.run('final', true, signal(), async () => {
    order.push('final')
    return 'final'
  })
  const latest = scheduler.run('new-caption', false, signal(), async () => {
    order.push('latest')
    return 'latest'
  })
  // Queue cancellation is observable before the running native call finishes.
  await Promise.resolve()
  const rejection = await Promise.race([stale, Promise.resolve('still pending')])
  expect(rejection).toBeInstanceOf(Error)
  gate.resolve('done')
  await active
  expect(await final).toBe('final')
  expect(await latest).toBe('latest')
  expect(order).toEqual(['final', 'latest'])
})
