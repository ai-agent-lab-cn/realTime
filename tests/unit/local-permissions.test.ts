import { it, expect } from 'vitest'
import { allowAudioPermission, allowResource } from '../../electron/local-permissions'
it('grants microphone only to active top-level app requests; never video or subframes', () => {
  const base = {
    active: true,
    trusted: true,
    mainFrame: true,
    permission: 'media',
    types: ['audio'],
  }
  expect(allowAudioPermission(base)).toBe(true)
  for (const patch of [
    { active: false },
    { trusted: false },
    { mainFrame: false },
    { types: ['audio', 'video'] },
    { types: [] },
    { permission: 'geolocation' },
  ])
    expect(allowAudioPermission({ ...base, ...patch })).toBe(false)
})
it('blocks external web requests and lookalike localhost origins', () => {
  expect(allowResource('https://example.com', true)).toBe(false)
  expect(allowResource('http://127.0.0.1:5187.evil.com', true)).toBe(false)
  expect(allowResource('http://127.0.0.1:5187/@vite/client', true)).toBe(true)
  expect(allowResource('http://127.0.0.1:5187/', false)).toBe(false)
  expect(allowResource('file:///app/index.html', false)).toBe(true)
})
