/** ASR-only experiment; no microphone, UI changes or real MT. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { LocalRuntime } from '../../dist-electron/local-runtime.js'
import {
  cleanTranscript,
  normalizeTerms,
  transcriptIssue,
  pcmWav,
} from '../../dist-electron/local-processing.js'
import {
  decodePcmWav,
  replayPcm,
  energyBounds,
  stablePrefixLatency,
  terminalBoundaryMs,
  transcriptOutcome,
} from './streaming-asr/replay.mjs'
import { JsonWorker } from './streaming-asr/worker.mjs'
import { summarizeAsr } from './streaming-asr/metrics.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)),
  work = join(root, 'work/streaming-asr')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((r, j) => server.close((e) => (e ? j(e) : r())))
  return port
}
async function terminate(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit').catch(() => {})
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(timer)
  }
}
async function compileBaseline() {
  const result = {}
  for (const [name, exported] of [
    ['segmenter', 'SpeechSegmenter'],
    ['transcriptQueue', 'TranscriptQueue'],
  ]) {
    const source = await readFile(join(root, `src/audio/${name}.ts`), 'utf8')
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    const target = join(work, `baseline-${name}.mjs`)
    await writeFile(target, code)
    result[exported] = (await import(pathToFileURL(target).href))[exported]
  }
  return result
}
function joined(map) {
  return [...map]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .filter(Boolean)
    .join(' ')
}
function finishRow(row, origin, end) {
  const raw = row.events.find((e) => e.rawText?.trim()),
    accepted = row.events.find((e) => e.accepted && e.text?.trim())
  row.firstRawMs = origin === null || !raw ? null : Math.max(0, raw.receivedMs - origin)
  row.firstAcceptedMs =
    origin === null || !accepted ? null : Math.max(0, accepted.receivedMs - origin)
  row.stablePrefixMs = stablePrefixLatency(row.events, row.finalText, origin)
  row.endpointDelayMs =
    end === null || row.lastEndpointMs === undefined ? null : Math.max(0, row.lastEndpointMs - end)
  return row
}
async function main() {
  const args = process.argv.slice(2)
  let repeatCount = 3,
    chosen,
    smoke = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') {
      chosen = args[++i]
      if (!chosen || chosen.startsWith('--')) throw new Error('Missing case id')
    } else if (args[i] === '--repeats') repeatCount = Number(args[++i])
    else if (args[i] === '--smoke') smoke = true
    else if (args[i] !== '--dry-run') throw new Error('Unknown option')
  }
  if (!Number.isSafeInteger(repeatCount) || repeatCount < 1 || repeatCount > 3)
    throw new Error('repeats must be 1..3')
  const manifest = JSON.parse(
    await readFile(join(root, 'tests/fixtures/streaming-asr/manifest.json'), 'utf8'),
  )
  const cases = chosen ? manifest.cases.filter((c) => c.id === chosen) : manifest.cases
  if (!cases.length) throw new Error('Unknown case')
  const preview = {
    cases: cases.length,
    repeats: repeatCount,
    requests: cases.length * repeatCount * 2,
    audioSeconds: cases.reduce((n, c) => n + c.durationSeconds, 0),
    leadMs: 300,
    trailMs: 1600,
    chunkMs: 100,
    defaultChanged: false,
    mt: 'not executed',
  }
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(preview))
    return
  }
  await mkdir(work, { recursive: true })
  for (const sample of cases)
    if ((await hashFile(join(root, sample.file))) !== sample.sha256)
      throw new Error(`Audio hash mismatch: ${sample.id}`)
  const candidate = JSON.parse(
    await readFile(join(root, 'scripts/local/streaming-asr/candidate.json'), 'utf8'),
  )
  for (const file of candidate.weights.files)
    if ((await hashFile(join(root, file.path))) !== file.sha256)
      throw new Error(`Candidate hash mismatch: ${file.name}`)
  const baselineManifest = JSON.parse(await readFile(join(root, 'models/manifest.json'), 'utf8'))
  for (const entry of baselineManifest.filter(
    (x) => x.file !== 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  ))
    if ((await hashFile(join(root, 'models', entry.file))) !== entry.sha256)
      throw new Error(`Baseline model hash mismatch: ${entry.file}`)
  const modules = await compileBaseline()
  const runId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8)
  const dir = join(root, 'outputs/streaming-asr', runId)
  await mkdir(dir, { recursive: true })
  const report = {
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    completed: false,
    smoke,
    ...preview,
    candidate,
    manifest,
    parameters: {
      A: 'current SpeechSegmenter + TranscriptQueue + LocalRuntime ASR quality/carry path; Whisper small SileroVAD current API; MT non-inference stand-in only',
      B: 'stateful fp32 zipformer2 CPU2 greedy; official acoustic endpoint2.4/1.2/20; wrapper12s cap; backend tail .66s',
      hypothesisStage:
        'WER uses raw terminal model text, not retained display Partial; displayText and terminal quality status separate',
      measurement:
        'Node wall time; sample energy threshold proxy; no human first-valid semantic labels or physical microphone lag',
      residency:
        'Both recognizers resident but inference/replay strictly sequential; no translation model loaded',
      baselineMT:
        'No model: inert return value only to allow LocalRuntime completion/cancellation; all MT outputs and metrics excluded',
    },
    sourceHashes: {},
    modelHashesVerified: true,
    loadMs: {},
    warmup: [],
    rows: [],
    resourceSamples: [],
  }
  for (const path of [
    'src/audio/segmenter.ts',
    'src/audio/transcriptQueue.ts',
    'electron/local-models.ts',
    'electron/local-runtime.ts',
    'dist-electron/local-runtime.js',
    'dist-electron/local-processing.js',
    'scripts/local/streaming-asr/online.py',
    'scripts/local/streaming-asr/worker.mjs',
    'scripts/local/streaming-asr/replay.mjs',
    'scripts/local/streaming-asr/metrics.mjs',
    'scripts/local/compare-asr.mjs',
    'tests/fixtures/streaming-asr/manifest.json',
  ]) {
    report.sourceHashes[path] = await hashFile(join(root, path))
    const target = join(dir, 'sources', path)
    await mkdir(fileURLToPath(new URL('.', pathToFileURL(target))), { recursive: true })
    await writeFile(target, await readFile(join(root, path)))
  }
  const save = async () => {
    report.summary = summarizeAsr(report.rows, cases, repeatCount)
    await writeFile(join(dir, 'asr-results.json'), JSON.stringify(report, null, 2) + '\n')
  }
  const abort = new AbortController(),
    cancel = () => abort.abort(new Error('Experiment cancelled'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let whisper, online
  const profile = join(root, 'scripts/local/offline.sb'),
    port = await freePort(),
    route = '/' + randomUUID(),
    url = `http://127.0.0.1:${port}${route}`
  try {
    let started = performance.now()
    whisper = spawn(
      '/usr/bin/sandbox-exec',
      [
        '-f',
        profile,
        join(root, 'work/local-runtime/whisper.cpp/build/bin/whisper-server'),
        '-m',
        join(root, 'models/ggml-small.bin'),
        '--host',
        '127.0.0.1',
        '--port',
        `${port}`,
        '-l',
        'auto',
        '-t',
        '4',
        '-nf',
        '--vad',
        '-vm',
        join(root, 'models/ggml-silero-v5.1.2.bin'),
        '-vsd',
        '400',
        '-vspd',
        '200',
        '--request-path',
        route,
        '--public',
        join(work, 'no-public'),
      ],
      { cwd: root, stdio: 'ignore' },
    )
    let spawnError
    whisper.on('error', (e) => {
      spawnError = e
    })
    while (true) {
      abort.signal.throwIfAborted()
      if (spawnError) throw spawnError
      if (whisper.exitCode !== null || whisper.signalCode !== null)
        throw new Error('Whisper startup failed')
      try {
        if (
          (await fetch(url + '/health', { signal: AbortSignal.timeout(800), redirect: 'error' })).ok
        )
          break
      } catch {}
      if (performance.now() - started > 120000) throw new Error('Whisper startup timeout')
      await pause(200)
    }
    report.loadMs.A = performance.now() - started
    started = performance.now()
    online = spawn(
      '/usr/bin/sandbox-exec',
      [
        '-f',
        profile,
        join(root, candidate.runtime.python_path),
        '-u',
        join(root, 'scripts/local/streaming-asr/online.py'),
        '--model-dir',
        join(root, 'models', candidate.id),
      ],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const worker = new JsonWorker(online, abort.signal)
    await worker.wait((e) => e.type === 'ready', 120000)
    report.loadMs.B = performance.now() - started
    const resource = () => {
      try {
        const text = execFileSync(
          'ps',
          ['-o', 'pid=,rss=,%cpu=', '-p', `${whisper.pid},${online.pid}`],
          { encoding: 'utf8' },
        ).trim()
        report.resourceSamples.push({ at: new Date().toISOString(), values: text })
      } catch {
        report.resourceUnavailable = true
      }
    }
    console.log(JSON.stringify({ ready: true, loadMs: report.loadMs, runId }))
    const runA = async (sample, repeat) => {
      const pcm = decodePcmWav(await readFile(join(root, sample.file))),
        bounds = energyBounds(pcm),
        origin = bounds.startMs === null ? null : 300 + bounds.startMs,
        end = bounds.endMs === null ? null : 300 + bounds.endMs
      const row = {
        id: sample.id,
        arm: 'A',
        repeat,
        events: [],
        finalText: '',
        rawFinalText: '',
        elapsedMs: 0,
        speechStartMs: origin,
        speechEndMs: end,
        requests: [],
      }
      const base = performance.now(),
        token = randomUUID(),
        texts = new Map(),
        rawTexts = new Map(),
        issues = new Map()
      let active, failed
      const models = {
        prepare: async () => {},
        close: () => {},
        translate: async () => '[ASR-only experiment; no translation model invoked]',
        recognize: async (pcm, _terms, signal) => {
          const request = active,
            started = performance.now()
          const form = new FormData()
          form.set(
            'file',
            new Blob([new Uint8Array(pcmWav(pcm))], { type: 'audio/wav' }),
            'audio.wav',
          )
          for (const [k, v] of Object.entries({
            language: 'auto',
            temperature: '0',
            temperature_inc: '0',
            response_format: 'json',
            vad: 'true',
            suppress_non_speech: 'true',
            prompt: '',
          }))
            form.set(k, v)
          const response = await fetch(url + '/inference', {
            method: 'POST',
            body: form,
            signal: AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30000)]),
            redirect: 'error',
          })
          if (!response.ok) throw new Error(`Whisper HTTP ${response.status}`)
          const data = await response.json()
          if (typeof data.text !== 'string') throw new Error('Invalid Whisper result')
          row.requests.push({
            id: request.id,
            revision: request.revision,
            final: request.final,
            sampleEndMs: request.end * 1000,
            asrMs: performance.now() - started,
          })
          rawTexts.set(request.id, data.text.trim())
          row.events.push({
            type: 'raw',
            segment: request.id,
            rawText: data.text,
            receivedMs: performance.now() - base,
            sampleEndMs: request.end * 1000,
          })
          return data.text
        },
      }
      const runtime = new LocalRuntime(models)
      await runtime.prepare(token)
      const segmenter = new modules.SpeechSegmenter()
      const queue = new modules.TranscriptQueue(
        async (request) => {
          active = request
          return runtime.recognize(request, (en, caption) => {
            const id = caption?.id ?? request.id
            texts.set(id, en)
            row.events.push({
              type: request.final ? 'endpoint' : 'partial',
              segment: id,
              text: en,
              fullText: joined(texts),
              accepted: true,
              receivedMs: performance.now() - base,
              sampleEndMs: request.end * 1000,
            })
            if (request.final) row.lastEndpointMs = performance.now() - base
          })
        },
        (result, request) => {
          if (result.error) issues.set(request.id, result.error)
          else issues.delete(request.id)
          row.events.push({
            type: 'ack',
            segment: request.id,
            pending: !!result.pending,
            issue: result.error,
            receivedMs: performance.now() - base,
            sampleEndMs: request.end * 1000,
          })
        },
        3,
        (error) => {
          failed = error
        },
        (request) =>
          runtime.cancelRequest({
            token: request.token,
            id: request.id,
            revision: request.revision,
          }),
      )
      try {
        row.replay = await replayPcm(
          pcm,
          async (chunk) => {
            for (const segment of segmenter.push(chunk.pcm))
              queue.enqueue({ ...segment, token, terms: true, pcm: segment.pcm.buffer })
          },
          { signal: abort.signal },
        )
        await queue.idle()
        if (failed) throw failed
        row.rawFinalText = joined(rawTexts)
        Object.assign(row, transcriptOutcome(row.rawFinalText, joined(texts), [...issues.values()]))
      } catch (error) {
        row.error = error instanceof Error ? error.message : 'Baseline failed'
      } finally {
        queue.cancel()
        runtime.cancel(token)
        row.elapsedMs = performance.now() - base
      }
      return finishRow(row, origin, end)
    }
    const runB = async (sample, repeat) => {
      const pcm = decodePcmWav(await readFile(join(root, sample.file))),
        bounds = energyBounds(pcm),
        origin = bounds.startMs === null ? null : 300 + bounds.startMs,
        end = bounds.endMs === null ? null : 300 + bounds.endMs
      const row = {
        id: sample.id,
        arm: 'B',
        repeat,
        events: [],
        finalText: '',
        rawFinalText: '',
        elapsedMs: 0,
        speechStartMs: origin,
        speechEndMs: end,
      }
      const texts = new Map(),
        issues = new Map()
      let base
      worker.events = []
      await worker.send({ type: 'start', sampleRate: 16000 })
      await worker.wait((e) => e.type === 'started')
      base = performance.now()
      worker.listener = (event) => {
        if (!['partial', 'endpoint'].includes(event.type)) return
        const raw = event.text ?? '',
          text = normalizeTerms(cleanTranscript(raw)),
          duration = Math.max(0.1, (event.sampleEndMs - event.segmentStartMs) / 1000),
          issue = text ? transcriptIssue(text, duration) : undefined
        const accepted = !!text && !issue
        if (accepted) texts.set(event.segment, text)
        if (issue) issues.set(event.segment, issue)
        else issues.delete(event.segment)
        row.events.push({
          ...event,
          rawText: raw,
          text,
          accepted,
          issue,
          fullText: joined(texts),
          receivedMs: performance.now() - base,
        })
        if (event.type === 'endpoint') row.lastEndpointMs = performance.now() - base
      }
      try {
        row.replay = await replayPcm(
          pcm,
          async (chunk) =>
            worker.send({
              type: 'audio',
              sequence: chunk.sequence,
              sampleEndMs: chunk.sampleEndMs,
              pcm: Buffer.from(
                chunk.pcm.buffer,
                chunk.pcm.byteOffset,
                chunk.pcm.byteLength,
              ).toString('base64'),
            }),
          { signal: abort.signal },
        )
        const [done] = await Promise.all([
          worker.wait((e) => e.type === 'complete'),
          worker.send({ type: 'finish' }),
        ])
        row.rawFinalText = done.text
        Object.assign(row, transcriptOutcome(row.rawFinalText, joined(texts), [...issues.values()]))
        row.syntheticPaddingSamples = done.syntheticPaddingSamples
        row.lastEndpointMs = terminalBoundaryMs(row.events, performance.now() - base)
      } catch (error) {
        row.error = error instanceof Error ? error.message : 'Candidate failed'
        await worker.send({ type: 'cancel' }).catch(() => {})
        await worker.wait((e) => e.type === 'cancelled', 2000).catch(() => {})
      } finally {
        worker.listener = () => {}
        worker.events = []
        row.elapsedMs = performance.now() - base
      }
      return finishRow(row, origin, end)
    }
    const warmCase = manifest.cases.find((c) => c.id === 'numbers') ?? cases[0]
    for (const arm of ['A', 'B']) {
      const row = await (arm === 'A' ? runA : runB)(warmCase, 0)
      report.warmup.push(row)
      await save()
      if (row.error) throw new Error('Warmup failed: ' + row.error)
    }
    for (let repeat = 1; repeat <= repeatCount; repeat++)
      for (let i = 0; i < cases.length; i++)
        for (const arm of (i + repeat) % 2 ? ['A', 'B'] : ['B', 'A']) {
          abort.signal.throwIfAborted()
          const sample = cases[i],
            row = await (arm === 'A' ? runA : runB)(sample, repeat)
          report.rows.push(row)
          resource()
          await save()
          console.log(
            JSON.stringify({
              done: report.rows.length,
              of: preview.requests,
              id: row.id,
              arm,
              repeat,
              firstMs: row.firstAcceptedMs === null ? null : Math.round(row.firstAcceptedMs),
              failed: !!row.error,
            }),
          )
          if (row.error) throw new Error(`Replay failed ${row.id}/${arm}: ${row.error}`)
        }
    report.completed = true
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'ASR experiment failed'
    process.exitCode = 1
  } finally {
    abort.abort()
    await Promise.all([terminate(online), terminate(whisper)])
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    report.finishedAt = new Date().toISOString()
    await save()
    console.log('Results: ' + join(dir, 'asr-results.json'))
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'ASR experiment failed')
  process.exitCode = 1
})
