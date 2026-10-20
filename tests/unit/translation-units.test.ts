import { expect, it } from 'vitest'
import { completePrefix, joinContinuation } from '../../electron/translation-units'

it.each([
  ['Ask the U.S. team for the', ''],
  ['Wait... for the', ''],
  ['He said "Ready." Now the', 'He said "Ready."'],
  ['Costs are 3.14 dollars. Ask Dr.', 'Costs are 3.14 dollars.'],
])('keeps the same safe sentence boundary for %s', (text, prefix) => {
  expect(completePrefix(text)).toBe(prefix)
})

it('keeps quotation and decimal text intact during continuation', () => {
  expect(joinContinuation('The price of', 'of 3.14 dollars')).toBe('The price of 3.14 dollars')
})
