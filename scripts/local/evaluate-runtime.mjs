import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { NativeModels } from '../../dist-electron/local-models.js'
import { LocalRuntime } from '../../dist-electron/local-runtime.js'
const root = new URL('../../', import.meta.url).pathname
const output = new URL('../../outputs/local-runtime-evaluation/', import.meta.url)
await mkdir(output, { recursive: true })
const cases = JSON.parse(
  await readFile(new URL('../../tests/fixtures/local/manifest.json', import.meta.url), 'utf8'),
)
function decode(wav) {
  let data, rate, channels, bits
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4),
      size = wav.readUInt32LE(offset + 4)
    if (name === 'fmt ') {
      channels = wav.readUInt16LE(offset + 10)
      rate = wav.readUInt32LE(offset + 12)
      bits = wav.readUInt16LE(offset + 22)
    }
    if (name === 'data') data = wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  if (!data || rate !== 16000 || channels !== 1 || bits !== 16)
    throw new Error('Expected 16k mono PCM16')
  const pcm = new Float32Array(data.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2) / 32768
  return pcm.buffer
}
const models = new NativeModels(decodeURI(root)),
  runtime = new LocalRuntime(models),
  token = randomUUID()
const results = {
  date: new Date().toISOString(),
  method:
    'actual application NativeModels + LocalRuntime, Silero VAD, fixed synthetic full files; not microphone latency',
  samples: [],
}
try {
  const start = performance.now()
  await runtime.prepare(token)
  results.loadSeconds = (performance.now() - start) / 1000
  console.log('ready', results.loadSeconds)
  for (const [i, sample] of cases.entries()) {
    const pcm = decode(await readFile(new URL('../../' + sample.file, import.meta.url)))
    const start = performance.now()
    const transcript = await runtime.transcribe({
      token,
      id: i,
      revision: 1,
      pcm,
      final: true,
      time: 0,
      terms: true,
    })
    const row = { ...sample, ...transcript, seconds: (performance.now() - start) / 1000 }
    results.samples.push(row)
    console.log(JSON.stringify(row))
    await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2))
  }
  let seed = 42
  const noise = Float32Array.from({ length: 64000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed / 4294967296 - 0.5) * 0.04
  })
  const nonSpeech = await runtime.transcribe({
    token,
    id: 99,
    revision: 1,
    pcm: noise.buffer,
    final: true,
    time: 0,
    terms: true,
  })
  results.samples.push({ id: 'fixed_noise', ...nonSpeech })
  console.log('noise', nonSpeech)
  results.completed = true
} finally {
  runtime.close()
  await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2))
}
