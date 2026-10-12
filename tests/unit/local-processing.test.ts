import { describe, expect, it } from 'vitest'
import {
  cleanTranscript,
  normalizeTerms,
  pcmWav,
  validateAudio,
  translationPrompt,
} from '../../electron/local-processing'
const token = '11111111-1111-4111-8111-111111111111'
const request = () => ({
  token,
  id: 0,
  revision: 1,
  pcm: new Float32Array(16000).buffer,
  final: false,
  time: 0,
  terms: true,
})
describe('local audio boundary', () => {
  it('rejects oversized, malformed, nonfinite PCM and invalid metadata', () => {
    expect(() => validateAudio(request())).not.toThrow()
    for (const patch of [
      { pcm: new ArrayBuffer(192001 * 4) },
      { pcm: new ArrayBuffer(3) },
      { pcm: new Float32Array([NaN]).buffer },
      { token: 'bad' },
      { id: -1 },
      { time: Infinity },
      { final: 'yes' },
      { terms: null },
    ]) {
      expect(() => validateAudio({ ...request(), ...patch })).toThrow()
    }
  })
  it('encodes 16kHz mono signed PCM with clipping', () => {
    const wav = pcmWav(new Float32Array([-1, 0, 1]).buffer)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readInt16LE(44)).toBe(-32768)
    expect(wav.readInt16LE(48)).toBe(32767)
  })
})
describe('non speech and terminology', () => {
  it('removes native noise markers without deleting spoken words', () => {
    for (const text of ['[BLANK_AUDIO]', '(silence)', '[Music] ♪', '[NO_SPEECH]', '…'])
      expect(cleanTranscript(text)).toBe('')
    expect(cleanTranscript('[Music] Hello, do not delete it.')).toBe('Hello, do not delete it.')
    expect(cleanTranscript('The word silence is meaningful.')).toContain('silence')
  })
  it('normalizes known tokens without inventing corrections to unknown words', () => {
    expect(normalizeTerms('rag pipeline uses api and pull request')).toBe(
      'RAG pipeline uses API and Pull Request',
    )
    expect(normalizeTerms('WebKeeperLine and TIMAT')).toBe('WebKeeperLine and TIMAT')
    expect(normalizeTerms('fragment capillary rapid')).toBe('fragment capillary rapid')
    expect(translationPrompt(true)).toContain('Agent')
  })
})

import { transcriptIssue } from '../../electron/local-processing'
it('keeps normal emphasis, enumerations, R&D terms and Chinese intact', () => {
  for (const text of [
    'Very, very important. We need resources and we need time.',
    'Firstly, the percentage of revenue spent on R&D is regularly updated. Secondly, it is public.',
    '研发投入比例会定期更新。这些信息是公开的，也反映了业务风险。',
  ])
    expect(transcriptIssue(text, 10)).toBeUndefined()
})
it('flags implausibly long output even without repeated words', () => {
  expect(transcriptIssue(Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '), 1)).toContain(
    '过长',
  )
})
