/** Isolated prompt experiment. No app source, ASR, microphone or app cache. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { readTranslationStream } from '../../dist-electron/translation-stream.js'
import { experimentSchedule, messagesFor, selectContext, summarize } from './context-experiment.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixturePath = join(root, 'tests/fixtures/translation-context/cases.json')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function main() {
  const args = process.argv.slice(2)
  let repeats = 3, chosen
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') {
      chosen = args[++i]
      if (!chosen || chosen.startsWith('--')) throw new Error('Missing case id')
    }
    else if (args[i] === '--repeats') repeats = Number(args[++i])
    else if (args[i] !== '--dry-run') throw new Error('Unknown option')
  }
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'))
  const cases = chosen ? fixtures.cases.filter((sample) => sample.id === chosen) : fixtures.cases
  if (!cases.length) throw new Error('Unknown case')
  const schedule = experimentSchedule(cases, repeats)
  const preview = {
    caseCount: cases.length,
    targetCount: cases.filter((sample) => sample.group === 'target').length,
    controlCount: cases.filter((sample) => sample.group === 'control').length,
    requests: schedule.length,
    repeats,
    applicationChanged: false,
    cachePrompt: false,
    noContextFallbackIds: cases.filter((sample) => !selectContext(sample.context).length).map((sample) => sample.id),
  }
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(preview))
    return
  }
  if (process.platform !== 'darwin') throw new Error('This experiment requires the prepared macOS runtime')
  const binary = join(root, 'work/local-runtime/llama.cpp/build/bin/llama-server')
  const profile = join(root, 'scripts/local/offline.sb')
  const manifest = JSON.parse(await readFile(join(root, 'models/manifest.json'), 'utf8'))
  const model = manifest.find((entry) => entry.file === 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf')
  if (!model) throw new Error('Missing fixed model manifest')
  const modelPath = join(root, 'models', model.file)
  await Promise.all([binary, profile, modelPath].map((path) => access(path)))
  console.log('Verifying fixed local model...')
  const actualHash = await sha256(modelPath)
  if (actualHash !== model.sha256) throw new Error('Model SHA-256 mismatch')
  const runId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8)
  const directory = join(root, 'outputs/translation-context', runId)
  await mkdir(directory, { recursive: true })
  const resultsPath = join(directory, 'results.json')
  const port = await freePort(), key = randomUUID(), url = `http://127.0.0.1:${port}`
  const signal = new AbortController()
  const cancel = () => signal.abort(new Error('Experiment cancelled'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const report = {
    version: 1, runId, startedAt: new Date().toISOString(), ...preview,
    method: 'Authored English text, sequential paired A/B, three warm repetitions; prompt-only timings, not speech-to-subtitle latency. No application cache; server cache_prompt=false.',
    scope: 'Text A/B only; runtime context history/cache/Final and real audio not implemented or tested.',
    parameters: { temperature: 0, seed: 42, max_tokens: 256, terms: true, contextSize: 4096, gpuLayers: 99, threads: 4, parallel: 1, stream: true, cache_prompt: false },
    promptVersion: { A: 'current-built-translationPrompt-terms-true', B: 'context-json-v1' },
    model: { ...model, verifiedSha256: actualHash },
    llamaCommit: execFileSync('git', ['-C', dirname(dirname(dirname(binary))), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    provenance: Object.fromEntries(await Promise.all(['dist-electron/local-processing.js', 'dist-electron/sentence-boundaries.js', 'dist-electron/translation-stream.js', 'scripts/local/context-experiment.mjs', 'scripts/local/evaluate-context.mjs', 'tests/fixtures/translation-context/cases.json', 'scripts/local/offline.sb'].map(async (path) => [path, await sha256(join(root, path))]))),
    inferenceNetwork: 'llama-server launched under existing offline.sb; loopback only; no models or tools downloaded.',
    qualityStatus: 'pending_human_review',
    cacheLayer: 'No TranslationMemory or scheduler. Raw model inference only; KV prompt reuse disabled in every request.',
    warmup: [], cases: cases.map((sample) => ({ ...sample, selectedContext: selectContext(sample.context) })), rows: [], completed: false,
  }
  const save = async () => {
    report.summary = summarize(report.rows, schedule)
    await writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n')
  }
  let child
  try {
    const started = performance.now()
    child = spawn('/usr/bin/sandbox-exec', ['-f', profile, binary, '-m', modelPath, '--host', '127.0.0.1', '--port', `${port}`, '-c', '4096', '-ngl', '99', '-t', '4', '-np', '1', '--no-webui', '--api-key', key], { cwd: root, stdio: 'ignore' })
    let spawnError
    child.on('error', (error) => { spawnError = error })
    while (true) {
      signal.signal.throwIfAborted()
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Local model process exited during startup')
      try {
        const response = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(800), redirect: 'error' })
        if (response.ok) break
      } catch { /* Model loads before serving health. */ }
      if (performance.now() - started > 120000) throw new Error('Local model startup timeout')
      await pause(200)
    }
    report.modelLoadMs = performance.now() - started
    const infer = async (sample, arm, repeat) => {
      const messages = messagesFor(sample, arm, true)
      const began = performance.now()
      let firstMs = null
      const result = { id: sample.id, arm, repeat, firstMs, totalMs: 0, messages, promptCharacters: messages.reduce((n, item) => n + [...item.content].length, 0) }
      const requestSignal = AbortSignal.any([signal.signal, AbortSignal.timeout(30000)])
      try {
        const response = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, redirect: 'error', signal: requestSignal,
          body: JSON.stringify({ messages, temperature: 0, max_tokens: 256, stream: true, seed: 42, cache_prompt: false }),
        })
        if (!response.ok) throw new Error(`Local translation HTTP ${response.status}`)
        result.text = await readTranslationStream(response, requestSignal, (text) => { if (text && firstMs === null) firstMs = performance.now() - began })
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Local translation failed'
      }
      result.firstMs = firstMs
      result.totalMs = performance.now() - began
      return result
    }
    const calibration = { id: 'warmup', context: ['The rule applies to uploads.'], target: 'It does not apply to downloads.' }
    for (const arm of ['A', 'B']) {
      const warm = await infer(calibration, arm, -1)
      report.warmup.push(warm)
      await save()
      if (warm.error) throw new Error('Calibration request failed')
    }
    let consecutiveFailures = 0
    for (const entry of schedule) {
      signal.signal.throwIfAborted()
      const sample = cases.find((item) => item.id === entry.id)
      const row = await infer(sample, entry.arm, entry.repeat)
      report.rows.push(row)
      await save()
      console.log(JSON.stringify({ done: report.rows.length, of: schedule.length, id: row.id, arm: row.arm, repeat: row.repeat, firstMs: row.firstMs === null ? null : Math.round(row.firstMs), totalMs: Math.round(row.totalMs), failed: !!row.error }))
      consecutiveFailures = row.error ? consecutiveFailures + 1 : 0
      if (consecutiveFailures >= 3) throw new Error('Three consecutive inference failures; partial results retained')
    }
    report.completed = true
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'Experiment failed'
    process.exitCode = 1
  } finally {
    signal.abort()
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {})
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(timer)
    }
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    report.finishedAt = new Date().toISOString()
    await save()
    console.log(`Results: ${resultsPath}`)
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Experiment failed'); process.exitCode = 1 })
