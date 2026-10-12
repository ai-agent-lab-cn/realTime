// Conservative text boundaries, not a semantic sentence parser.
export function questionPunctuation(text: string): string {
  return text.replace(/[^!?]+?(?:\.(?![.\d])|[!?])/g, (whole) => {
    if (!whole.endsWith('.') || whole.endsWith('..')) return whole
    const sentence = whole.slice(0, -1)
    const body = sentence
      .trim()
      .replace(/^(?:(?:and\s+)?(?:first|second|third|fourth|then|next)[,:]?\s+)/i, '')
    if (
      /^which\s+(?:is|are|was|were)\s+(?:why|how|what|where|when)\b/i.test(body) ||
      /^what\s+(?:is|are|was|were)\b.+\b(?:is|are|was|were)\b/i.test(body)
    )
      return whole
    return /^(?:why|how|when|where|which|what)\s+(?:is|are|was|were|do|does|did|can|could|will|would|should|has|have)\b/i.test(
      body,
    )
      ? `${sentence}?`
      : whole
  })
}
export function hasOpenTail(text: string): boolean {
  return /\b(?:of|to|and|or|the|a|an|in|on|for|with|at|by|because|although|if)\s*$/i.test(text)
}
export function completePrefix(text: string): string {
  if (/[.!?]$/.test(text.trim()) && !/\b(?:mr|mrs|ms|dr|prof|e\.g|i\.e)\.$/i.test(text.trim()))
    return text.trim()
  let end = 0
  for (const match of text.matchAll(/[.!?]\s+/g)) {
    const prefix = text.slice(0, match.index! + 1)
    if (!/\b(?:mr|mrs|ms|dr|prof|e\.g|i\.e)\.$/i.test(prefix)) end = match.index! + 1
  }
  return text.slice(0, end).trim()
}
export function joinContinuation(left: string, right: string): string {
  // Only collapse a repeated boundary function word, never repeated emphasis.
  const last = left.match(/\b(of|to|and|the|a|an|in|on|for|with|at|by)\s*$/i)?.[1]
  const rest = last ? right.replace(new RegExp(`^${last}\\b\\s*`, 'i'), '') : right
  return `${left.trim()} ${rest.trim()}`.trim()
}
