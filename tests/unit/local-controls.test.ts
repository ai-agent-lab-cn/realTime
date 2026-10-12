import { afterEach, expect, it, vi } from 'vitest'
import { createSSRApp, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../src/composables/useLocalInterpreter', () => ({
  useLocalInterpreter: () => ({
    busy: ref(true),
    error: ref(''),
    begin: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
    cancelPreparing: vi.fn(),
    dispose: vi.fn(),
  }),
}))

import App from '../../src/App.vue'
import { useInterpreter } from '../../src/stores/interpreter'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('offers cancellation while a stopped session is preparing to restart', async () => {
  vi.stubGlobal('window', { desktop: { local: {} } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useInterpreter()
  store.source = 'local'
  store.start()
  store.stop()
  const html = await renderToString(createSSRApp(App).use(pinia))
  expect(html).toContain('取消准备')
  expect(html).not.toContain('>重新开始')
})
