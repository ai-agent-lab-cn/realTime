/** Fixed experiment normalization: lowercase, punctuation/symbols -> spaces, whitespace split.
 * Numeral spelling is deliberately not normalized. Mixed-language cases are never English WER.
 */
function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
}

export function scoreTranscript(reference, hypothesis) {
  const a = words(reference),
    b = words(hypothesis)
  const table = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) table[i][0] = i
  for (let j = 0; j <= b.length; j++) table[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]),
      )
    }
  }
  let i = a.length,
    j = b.length,
    substitutions = 0,
    deletions = 0,
    insertions = 0
  // Deterministic tie order: match, substitution, deletion, insertion.
  while (i || j) {
    if (i && j && a[i - 1] === b[j - 1] && table[i][j] === table[i - 1][j - 1]) {
      i--
      j--
    } else if (i && j && table[i][j] === table[i - 1][j - 1] + 1) {
      substitutions++
      i--
      j--
    } else if (i && table[i][j] === table[i - 1][j] + 1) {
      deletions++
      i--
    } else {
      insertions++
      j--
    }
  }
  const errors = substitutions + deletions + insertions
  return {
    substitutions,
    deletions,
    insertions,
    referenceWords: a.length,
    errors,
    wer: a.length ? errors / a.length : null,
  }
}

const arms = ['A', 'B']
const metricNames = [
  'firstRawMs',
  'firstAcceptedMs',
  'stablePrefixMs',
  'endpointDelayMs',
  'elapsedMs',
]
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
function quantile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b),
    index = (sorted.length - 1) * p
  const lo = Math.floor(index),
    hi = Math.ceil(index)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo)
}
function distribution(values) {
  const usable = values.filter(finite)
  return { n: usable.length, median: quantile(usable, 0.5), p95: quantile(usable, 0.95) }
}
function coverage(planned, rows) {
  const failed = rows.filter((row) => Boolean(row.error)).length
  return {
    planned,
    attempted: rows.length,
    successful: rows.length - failed,
    failed,
    missing: planned - rows.length,
  }
}
function combineCoverage(entries) {
  return Object.fromEntries(
    ['planned', 'attempted', 'successful', 'failed', 'missing'].map((key) => [
      key,
      entries.reduce((sum, entry) => sum + entry.coverage[key], 0),
    ]),
  )
}
function aggregate(entries) {
  return {
    coverage: combineCoverage(entries),
    metrics: Object.fromEntries(
      metricNames.map((name) => [name, distribution(entries.map((entry) => entry.metrics[name]))]),
    ),
  }
}

/** Repeats are 1-based; a failed row is attempted, an absent planned row is missing.
 * Latency summaries exclude failed runs and preserve absent metrics as null.
 * Case medians precede cross-case quantiles, so repeated audio never inflates n.
 */
export function summarizeAsr(rows, cases, repeats = 3) {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('repeats must be a positive integer')
  const ids = new Set(cases.map((sample) => sample.id))
  if (ids.size !== cases.length) throw new Error('duplicate case id')
  const seen = new Set()
  for (const row of rows) {
    if (
      !ids.has(row.id) ||
      !arms.includes(row.arm) ||
      !Number.isInteger(row.repeat) ||
      row.repeat < 1 ||
      row.repeat > repeats
    )
      throw new Error(`unplanned run: ${row.id}/${row.arm}/${row.repeat}`)
    const key = JSON.stringify([row.id, row.arm, row.repeat])
    if (seen.has(key)) throw new Error(`duplicate run: ${key}`)
    seen.add(key)
  }
  const runsFor = (id, arm) => rows.filter((row) => row.id === id && row.arm === arm)
  const byCase = cases.flatMap((sample) =>
    arms.map((arm) => {
      const runs = runsFor(sample.id, arm),
        successful = runs.filter((row) => !row.error)
      return {
        id: sample.id,
        group: sample.group,
        language: sample.language,
        referenceStatus: sample.referenceStatus,
        arm,
        coverage: coverage(repeats, runs),
        metrics: Object.fromEntries(
          metricNames.map((name) => [
            name,
            quantile(successful.map((row) => row[name]).filter(finite), 0.5),
          ]),
        ),
      }
    }),
  )
  const overall = Object.fromEntries(
    arms.map((arm) => [arm, aggregate(byCase.filter((entry) => entry.arm === arm))]),
  )
  const groups = Object.fromEntries(
    [...new Set(cases.map((sample) => sample.group))].map((group) => [
      group,
      Object.fromEntries(
        arms.map((arm) => [
          arm,
          aggregate(byCase.filter((entry) => entry.arm === arm && entry.group === group)),
        ]),
      ),
    ]),
  )
  function werFor(status, arm) {
    const eligible = cases.filter(
      (sample) =>
        sample.language === 'en' &&
        sample.referenceStatus === status &&
        words(sample.reference).length,
    )
    const details = eligible.flatMap((sample) => {
      const scored = runsFor(sample.id, arm)
        .filter((row) => !row.error)
        .map((row) => ({ repeat: row.repeat, ...scoreTranscript(sample.reference, row.finalText) }))
        .sort((a, b) => a.wer - b.wer || a.repeat - b.repeat)
      if (!scored.length) return []
      return [
        {
          id: sample.id,
          availableRepeats: scored.length,
          ...scored[Math.floor((scored.length - 1) / 2)],
        },
      ]
    })
    const referenceWords = details.reduce((sum, row) => sum + row.referenceWords, 0),
      errors = details.reduce((sum, row) => sum + row.errors, 0)
    return {
      plannedCases: eligible.length,
      scoredCases: details.length,
      missingCases: eligible.length - details.length,
      referenceWords,
      errors,
      wer: referenceWords ? errors / referenceWords : null,
      details,
    }
  }
  return {
    method: {
      normalization:
        'Lowercase; Unicode punctuation and symbols become spaces; whitespace tokens; no number-word equivalence.',
      latency:
        'Median of successful repeats per case and arm, then across-case median and linearly interpolated P95. n counts distinct cases with a non-null metric; failed and missing runs are reported separately.',
      wer: 'Only human_confirmed English or synthetic_known_text English, separately. One observed median-WER representative per case and arm; for even available repeat counts choose the lower middle. Sum representative edits/reference words once per audio; missing/failed runs do not count as correct.',
      firstAcceptedMs:
        'ASR quality-gate acceptance only; not human-confirmed semantic validity or an effective-semantic-latency claim.',
      stablePrefixMs: 'Null if not measured; never imputed as zero.',
    },
    coverage: coverage(cases.length * arms.length * repeats, rows),
    byCase,
    overall,
    groups,
    humanEnglishWER: Object.fromEntries(arms.map((arm) => [arm, werFor('human_confirmed', arm)])),
    syntheticEnglishWER: Object.fromEntries(
      arms.map((arm) => [arm, werFor('synthetic_known_text', arm)]),
    ),
  }
}
