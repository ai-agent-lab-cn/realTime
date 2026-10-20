export type SentenceUnit = { text: string; closed: boolean; end: number }
const abbreviation =
  /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|fig|no|inc|ltd|e\.g|i\.e|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i
const closingQuote = /["'”’»）)\]}]/

/** Only punctuation with a clear boundary closes a unit. Separator whitespace is
 * trimmed; all words, numbers, punctuation and internal whitespace are retained.
 * Ambiguous abbreviations, initials and ellipses stay in the larger unit. */
export function sentenceUnits(text: string): SentenceUnit[] {
  const units: SentenceUnit[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const punctuation = text[i]
    if (!/[.!?。！？]/.test(punctuation)) continue
    if (punctuation === '.') {
      if (text[i - 1] === '.' || text[i + 1] === '.' || text[i - 1] === '…') continue
      if (/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue
      const token = text.slice(start, i).match(/[A-Za-z.]+$/)?.[0] ?? ''
      if (abbreviation.test(token) || /^[A-Za-z]$/.test(token) || token.includes('.')) continue
    }
    let end = i + 1
    while (end < text.length && /[!?！？]/.test(text[end])) end++
    while (end < text.length && closingQuote.test(text[end])) end++
    // English punctuation inside a token (e.g. a URL) is not a sentence break.
    if (end < text.length && !/\s/.test(text[end]) && /[.!?]/.test(punctuation)) continue
    const source = text.slice(start, end).trim()
    if (source) units.push({ text: source, closed: true, end })
    start = end
    i = end - 1
  }
  const tail = text.slice(start).trim()
  if (tail) units.push({ text: tail, closed: false, end: text.length })
  return units
}
