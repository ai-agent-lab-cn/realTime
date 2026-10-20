import { sentenceUnits } from './sentence-boundaries.js'
import type { CompletedTranslationUnit } from './local-types.js'

type Translate = (
  text: string,
  terms: boolean,
  signal: AbortSignal,
  onProgress?: (zh: string) => void,
) => Promise<string>

const LIMIT = 128

/** ASR whitespace carries no lexical meaning. Keep all words, punctuation,
 * numbers, case and terminology settings in the key. */
export function translationKey(text: string, terms: boolean): string {
  return JSON.stringify([terms, text.replace(/\s+/g, ' ').trim()])
}

function remember(cache: Map<string, string>, key: string, value: string): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value!)
}

/** Session-local exact reuse, never fuzzy matching. Closed units use a bounded
 * LRU; the single latest whole-text result also covers unchanged open Partial →
 * Final. Translated units are joined with newlines in results and progress. */
export class TranslationMemory {
  private readonly closed = new Map<string, string>()
  private latest?: { key: string; zh: string; units: CompletedTranslationUnit[] }
  private generation = 0

  clear(): void {
    this.generation++
    this.closed.clear()
    this.latest = undefined
  }

  async translate(
    text: string,
    terms: boolean,
    signal: AbortSignal,
    translate: Translate,
    onProgress?: (zh: string, units: CompletedTranslationUnit[]) => void,
  ): Promise<string> {
    const generation = this.generation
    const current = () => !signal.aborted && generation === this.generation
    const assertCurrent = () => {
      if (!current()) throw new DOMException('Translation canceled', 'AbortError')
    }
    const key = translationKey(text, terms)
    let lastPublished: string | undefined
    const completed: CompletedTranslationUnit[] = []
    const publish = (zh: string) => {
      const signature = JSON.stringify([zh, completed])
      if (!current() || !zh || signature === lastPublished) return
      lastPublished = signature
      onProgress?.(
        zh,
        completed.map((unit) => ({ ...unit })),
      )
    }
    assertCurrent()
    if (this.latest?.key === key) {
      const zh = this.latest.zh
      completed.push(...this.latest.units)
      publish(zh)
      assertCurrent()
      return zh
    }

    const translated: string[] = []
    // Transactional staging prevents a later failed/canceled unit from caching
    // earlier work. It is bounded separately even for a very long input.
    const staged = new Map<string, string>()
    for (const unit of sentenceUnits(text)) {
      assertCurrent()
      const unitKey = translationKey(unit.text, terms)
      let zh = unit.closed ? (staged.get(unitKey) ?? this.closed.get(unitKey)) : undefined
      if (zh === undefined) {
        let acceptingProgress = true
        try {
          zh = await translate(unit.text, terms, signal, (tail) => {
            if (acceptingProgress) publish([...translated, tail].filter(Boolean).join('\n'))
          })
        } finally {
          acceptingProgress = false
        }
        assertCurrent()
      }
      if (typeof zh !== 'string' || !zh.trim()) {
        throw new Error('本地翻译未返回有效译文')
      }
      if (unit.closed) remember(staged, unitKey, zh)
      translated.push(zh)
      if (unit.closed) completed.push({ source: unit.text, zh })
      publish(translated.filter(Boolean).join('\n'))
    }

    assertCurrent()
    const zh = translated.filter(Boolean).join('\n')
    for (const [unitKey, value] of staged) remember(this.closed, unitKey, value)
    this.latest = { key, zh, units: completed.map((unit) => ({ ...unit })) }
    return zh
  }
}
