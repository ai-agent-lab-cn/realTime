import { createInterface } from 'node:readline'

/** Bounded JSON-lines IPC for the independent ASR experiment. */
export class JsonWorker {
  constructor(child, signal, drainTimeoutMs = 5000) {
    this.child = child
    this.events = []
    this.listener = () => {}
    this.waiters = new Set()
    this.drains = new Set()
    this.stderrBytes = Buffer.alloc(0)
    this.signal = signal
    this.drainTimeoutMs = drainTimeoutMs
    this.onStderr = data => {
      this.stderrBytes = Buffer.concat([this.stderrBytes, Buffer.from(data)]).subarray(-12000)
    }
    this.onError = error => this.fail(error)
    this.onExit = (code, exitSignal) => {
      this.fail(new Error(`Online process exited ${code ?? exitSignal}: ${this.stderr}`))
      child.off('exit', this.onExit)
    }
    this.onAbort = () => this.fail(signal.reason instanceof Error ? signal.reason : new Error('Experiment cancelled'))
    this.onStdinClose = () => {
      this.fail(new Error('Online stdin closed'))
      child.stdin.off('error', this.onError)
      child.stdin.off('close', this.onStdinClose)
    }
    this.onStdoutClose = () => this.fail(new Error('Online stdout closed'))
    this.onClose = () => {
      this.fail(new Error('Online process closed'))
      child.off('exit', this.onExit)
      child.off('error', this.onError)
      child.off('close', this.onClose)
      child.stdin.off('error', this.onError)
      child.stdin.off('close', this.onStdinClose)
      child.stdout.off('error', this.onError)
      child.stdout.off('close', this.onStdoutClose)
      child.stderr.off('error', this.onError)
    }
    this.lines = createInterface({ input: child.stdout })
    this.onLine = line => {
      if (this.error) return
      try {
        const event = JSON.parse(line)
        if (this.events.length >= 4096) throw new Error('Online event queue exceeds 4096 entries')
        this.events.push(event)
        this.listener(event)
        this.flush()
      } catch (error) {
        this.fail(error)
      }
    }
    this.lines.on('line', this.onLine)
    child.stderr.on('data', this.onStderr)
    child.stderr.on('error', this.onError)
    child.stdout.on('error', this.onError)
    child.stdout.on('close', this.onStdoutClose)
    // Keep error guards until pipe/process closure: EPIPE can follow cancellation.
    child.stdin.on('error', this.onError)
    child.stdin.on('close', this.onStdinClose)
    child.on('error', this.onError)
    child.on('exit', this.onExit)
    child.on('close', this.onClose)
    signal?.addEventListener('abort', this.onAbort, { once: true })
    if (signal?.aborted) this.onAbort()
  }

  get stderr() {
    let text = this.stderrBytes.toString('utf8')
    while (Buffer.byteLength(text) > 12000) text = text.slice(1)
    return text
  }

  fail(error) {
    if (this.error) return
    this.error = error instanceof Error ? error : new Error(String(error))
    this.signal?.removeEventListener('abort', this.onAbort)
    this.lines.off('line', this.onLine)
    this.lines.close()
    this.child.stderr.off('data', this.onStderr)
    this.events = []
    for (const waiter of [...this.waiters]) waiter.finish(this.error)
    for (const drain of [...this.drains]) drain(this.error)
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      if (this.error) return
      try {
        const index = this.events.findIndex(waiter.predicate)
        if (index >= 0) waiter.finish(undefined, this.events.splice(index, 1)[0])
      } catch (error) {
        this.fail(error)
      }
    }
  }

  wait(predicate, timeout = 30000) {
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        finish: (error, event) => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          if (error) reject(error)
          else resolve(event)
        },
      }
      const timer = setTimeout(() => waiter.finish(new Error(`Online response timeout: ${this.stderr}`)), timeout)
      this.waiters.add(waiter)
      this.flush()
    })
  }

  async send(event) {
    if (this.error) throw this.error
    let writable
    try {
      writable = this.child.stdin.write(JSON.stringify(event) + '\n')
    } catch (error) {
      this.fail(error)
      throw this.error
    }
    if (this.error) throw this.error
    if (writable) return
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        this.child.stdin.off('drain', onDrain)
        this.drains.delete(finish)
        if (error) reject(error)
        else resolve()
      }
      const onDrain = () => finish()
      const timer = setTimeout(() => this.fail(new Error(`Online stdin drain timeout: ${this.stderr}`)), this.drainTimeoutMs)
      this.drains.add(finish)
      this.child.stdin.once('drain', onDrain)
    })
  }
}
