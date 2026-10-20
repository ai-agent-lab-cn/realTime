import { it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'

it('previews the complete paired experiment without loading models', () => {
  const data = JSON.parse(execFileSync(process.execPath, ['scripts/local/evaluate-context.mjs', '--dry-run'], { encoding: 'utf8' }))
  expect(data.caseCount).toBe(20)
  expect(data.targetCount).toBe(12)
  expect(data.controlCount).toBe(8)
  expect(data.requests).toBe(120)
  expect(data.applicationChanged).toBe(false)
  expect(data.cachePrompt).toBe(false)
  expect(data.noContextFallbackIds).toEqual(['control_01', 'control_06'])
})

it('rejects unknown cases before starting a local server', () => {
  const result = spawnSync(process.execPath, ['scripts/local/evaluate-context.mjs', '--case', 'missing', '--dry-run'], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Unknown case')
})

it('does not expand a missing case argument into a full expensive experiment', () => {
  const result = spawnSync(process.execPath, ['scripts/local/evaluate-context.mjs', '--dry-run', '--case'], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Missing case id')
  expect(result.stdout).not.toContain('Verifying fixed local model')
})
