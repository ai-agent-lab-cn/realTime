import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { pcmWav, translationPrompt } from './local-processing.js'
import type { Models } from './local-runtime.js'
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}
export class NativeModels implements Models {
  private children: ChildProcess[] = []
  private ready: Promise<void> | null = null
  private generation = 0
  private asr = ''
  private mt = ''
  private key = ''
  constructor(private root: string) {}
  prepare(): Promise<void> {
    if (!this.ready) {
      const generation = ++this.generation
      this.ready = this.start(generation).catch((error) => {
        if (this.generation === generation) this.close()
        throw error
      })
    }
    return this.ready
  }
  private async launch(binary: string, args: string[], health: string, generation: number) {
    if (generation !== this.generation) throw new Error('本地服务已取消')
    // Child processes inherit the offline profile; inference never downloads files.
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-f', join(this.root, 'scripts/local/offline.sb'), binary, ...args],
      { cwd: this.root, stdio: 'ignore' },
    )
    this.children.push(child)
    child.once('exit', () => {
      if (generation === this.generation) this.close()
    })
    let spawnError: Error | undefined
    child.once('error', (error) => {
      spawnError = error
    })
    const start = Date.now()
    while (Date.now() - start < 120000) {
      if (generation !== this.generation) throw new Error('本地服务已取消')
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error('本地模型进程启动失败，请检查运行工具与模型')
      try {
        const response = await fetch(health, {
          signal: AbortSignal.timeout(800),
          headers: { Authorization: `Bearer ${this.key}` },
          redirect: 'error',
        })
        if (response.ok) return
      } catch {
        /* The process may still be loading its model. */
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('本地模型加载超时，请稍后重试')
  }
  private async start(generation: number) {
    if (process.platform !== 'darwin') throw new Error('当前本地运行工具仅验证 macOS')
    const binary = (name: string) =>
      join(
        this.root,
        'work/local-runtime',
        name,
        'build/bin',
        name === 'whisper.cpp' ? 'whisper-server' : 'llama-server',
      )
    const model = (name: string) => join(this.root, 'models', name)
    const whisper = model('ggml-small.bin'),
      qwen = model('Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
      vad = model('ggml-silero-v5.1.2.bin')
    try {
      await Promise.all(
        [
          binary('whisper.cpp'),
          binary('llama.cpp'),
          whisper,
          qwen,
          vad,
          join(this.root, 'scripts/local/offline.sb'),
        ].map((path) => access(path)),
      )
    } catch {
      throw new Error('缺少本地模型或运行工具，请按 README 完成准备')
    }
    const asrPort = await freePort(),
      mtPort = await freePort()
    const route = `/${randomUUID()}`
    this.key = randomUUID()
    this.asr = `http://127.0.0.1:${asrPort}${route}`
    this.mt = `http://127.0.0.1:${mtPort}`
    await this.launch(
      binary('whisper.cpp'),
      [
        '-m',
        whisper,
        '--host',
        '127.0.0.1',
        '--port',
        `${asrPort}`,
        '-l',
        'auto',
        '-t',
        '4',
        '-nf',
        '--vad',
        '-vm',
        vad,
        '-vsd',
        '400',
        '-vspd',
        '200',
        '--request-path',
        route,
        '--public',
        join(this.root, 'work/local-runtime/no-public'),
      ],
      `${this.asr}/health`,
      generation,
    )
    await this.launch(
      binary('llama.cpp'),
      [
        '-m',
        qwen,
        '--host',
        '127.0.0.1',
        '--port',
        `${mtPort}`,
        '-c',
        '4096',
        '-ngl',
        '99',
        '-t',
        '4',
        '-np',
        '1',
        '--no-webui',
        '--api-key',
        this.key,
      ],
      `${this.mt}/health`,
      generation,
    )
    if (
      generation !== this.generation ||
      this.children.some((child) => child.exitCode !== null || child.signalCode !== null)
    )
      throw new Error('Local model exited during startup')
  }
  async recognize(pcm: ArrayBuffer, _terms: boolean, signal: AbortSignal): Promise<string> {
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(pcmWav(pcm))], { type: 'audio/wav' }), 'audio.wav')
    for (const [key, value] of Object.entries({
      language: 'auto',
      response_format: 'json',
      temperature: '0',
      temperature_inc: '0',
      vad: 'true',
      suppress_non_speech: 'true',
      // Translation terminology must not bias recognition of unrelated courses.
      prompt: '',
    }))
      form.set(key, value)
    const response = await fetch(`${this.asr}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('本地语音识别失败，请暂停后重试')
    const data = (await response.json()) as { text?: unknown }
    if (typeof data.text !== 'string' || data.text.length > 12000)
      throw new Error('本地识别结果无效')
    return data.text
  }
  async translate(text: string, terms: boolean, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.mt}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      redirect: 'error',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: translationPrompt(terms) },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 256,
        stream: false,
        seed: 42,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    })
    if (!response.ok) throw new Error('本地翻译服务不可用')
    const data = (await response.json()) as {
      choices?: { finish_reason?: string; message?: { content?: unknown } }[]
    }
    const choice = data.choices?.[0]
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
      throw new Error('翻译未完整完成')
    return choice.message.content.trim()
  }
  close() {
    this.generation++
    this.ready = null
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    }
    this.children = []
  }
}
