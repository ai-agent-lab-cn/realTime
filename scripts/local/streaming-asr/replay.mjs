import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export function decodePcmWav(wav) {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Invalid WAV')
  let fmt, data
  for (let offset = 12; offset + 8 <= wav.length;) {
    const type = wav.toString('ascii', offset, offset + 4),
      size = wav.readUInt32LE(offset + 4)
    if (offset + 8 + size > wav.length) throw new Error('Truncated WAV')
    if (type === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format')
      fmt = {
        format: wav.readUInt16LE(offset + 8),
        channels: wav.readUInt16LE(offset + 10),
        rate: wav.readUInt32LE(offset + 12),
        bits: wav.readUInt16LE(offset + 22),
      }
    }
    if (type === 'data') data = wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  if (
    !data ||
    !fmt ||
    fmt.format !== 1 ||
    fmt.channels !== 1 ||
    fmt.rate !== 16000 ||
    fmt.bits !== 16 ||
    data.length % 2
  )
    throw new Error('Expected mono 16kHz PCM16')
  return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768)
}

export function energyBounds(pcm) {
  let first = null,
    last = null
  for (let offset = 0; offset + 320 <= pcm.length; offset += 320) {
    let power = 0
    for (let i = offset; i < offset + 320; i++) power += pcm[i] * pcm[i]
    if (Math.sqrt(power / 320) >= 0.015) {
      first ??= offset / 16
      last = (offset + 320) / 16
    }
  }
  return { startMs: first, endMs: last }
}

export async function replayPcm(
  pcm,
  send,
  {
    leadMs = 300,
    trailMs = 1600,
    signal,
    now = () => performance.now(),
    sleep = (ms) => delay(ms, undefined, { signal }),
  } = {},
) {
  const lead = leadMs * 16,
    tail = trailMs * 16
  if (
    !(pcm instanceof Float32Array) ||
    !Number.isSafeInteger(lead) ||
    !Number.isSafeInteger(tail) ||
    lead < 0 ||
    tail < 0
  )
    throw new Error('Invalid replay bounds')
  const input = new Float32Array(lead + pcm.length + tail)
  input.set(pcm, lead)
  const started = now()
  let sequence = 0,
    maxLagMs = 0
  for (let offset = 0; offset < input.length; offset += 1600) {
    signal?.throwIfAborted()
    const chunk = input.slice(offset, Math.min(input.length, offset + 1600))
    const sampleEndMs = (offset + chunk.length) / 16
    const wait = started + sampleEndMs - now()
    if (wait > 0) await sleep(wait)
    signal?.throwIfAborted()
    maxLagMs = Math.max(maxLagMs, now() - started - sampleEndMs)
    await send({ sequence: sequence++, sampleEndMs, pcm: chunk })
  }
  return {
    inputSamples: input.length,
    chunkCount: sequence,
    maxLagMs,
    elapsedMs: now() - started,
    leadMs,
    trailMs,
  }
}

export function stablePrefixLatency(events, finalText, speechStartMs) {
  if (speechStartMs === null) return null
  const words = (text) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  const final = words(finalText),
    accepted = events.filter((x) => x.accepted && x.fullText.trim())
  if (final.length < 3) return null
  const prefix = final.slice(0, 3).join(' ')
  for (let i = 0; i < accepted.length; i++) {
    if (accepted.slice(i).every((x) => words(x.fullText).slice(0, 3).join(' ') === prefix))
      return Math.max(0, accepted[i].receivedMs - speechStartMs)
  }
  return null
}
export function terminalBoundaryMs(events, completedAt) {
  const lastText = events.findLast(
    (event) => event.accepted || (event.rawText ?? event.text ?? '').trim(),
  )
  const boundary = events.findLast((event) => event.type === 'endpoint')
  if (boundary && (!lastText || boundary.segment >= lastText.segment)) return boundary.receivedMs
  return completedAt
}
export function transcriptOutcome(rawText, displayText, issues = []) {
  const finalText = rawText.trim()
  return {
    finalText,
    displayText,
    terminalStatus: issues.length ? 'quality_rejected' : finalText ? 'recognized' : 'empty',
    terminalIssues: [...issues],
  }
}
