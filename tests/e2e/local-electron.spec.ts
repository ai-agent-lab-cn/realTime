import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('本地麦克风回放经过真实模型，暂停冻结，结束保存真实记录', async () => {
  test.setTimeout(100000)
  const desktop = await mkdtemp(join(tmpdir(), 'shiyi-local-desktop-'))
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    await app.evaluate(({ app }, path) => app.setPath('desktop', path), desktop)
    const page = await app.firstWindow()
    // Chromium's sandbox cannot read --use-file-for-fake-audio-capture on this Mac.
    // Keep the sandbox and permission path; inject a fixed in-memory MediaStream instead.
    const fixture = (await readFile('work/local-runtime/microphone-fixture.wav')).toString('base64')
    await page.addInitScript((base64) => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const permissionStream = await getUserMedia(constraints)
        permissionStream.getTracks().forEach((track) => track.stop())
        const context = new AudioContext()
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const buffer = await context.decodeAudioData(bytes.buffer)
        const source = context.createBufferSource()
        source.buffer = buffer
        const destination = context.createMediaStreamDestination()
        source.connect(destination)
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track)
          track.stop = () => {
            stop()
            source.stop()
            void context.close()
          }
        }
        await context.resume()
        source.start()
        return destination.stream
      }
    }, fixture)
    await page.reload()
    await page.evaluate(() => {
      const timings = { original: 0, translated: 0 }
      ;(window as any).__captionTimings = timings
      const observer = new MutationObserver(() => {
        if (!timings.original && document.querySelector('.caption .english')?.textContent?.trim())
          timings.original = performance.now()
        if (!timings.translated && document.querySelector('.caption .chinese')?.textContent?.trim())
          timings.translated = performance.now()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByLabel('音频来源')).toHaveValue('local')
    await page.getByRole('button', { name: '开始翻译', exact: true }).click()
    await expect(page.locator('.status-pill')).toContainText('Listening', { timeout: 50000 })
    await expect(page.locator('.caption.partial').first()).toBeVisible({ timeout: 20000 })
    await expect(page.locator('.caption.final').first()).toBeVisible({ timeout: 20000 })
    const timings = await page.evaluate(() => (window as any).__captionTimings)
    expect(timings.original).toBeGreaterThan(0)
    expect(timings.translated).toBeGreaterThan(timings.original)
    const first = await page.locator('.caption.final').first().innerText()
    expect(first).toContain('15')
    expect(first).toContain('50')
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const frozen = await page.locator('.feed').innerText()
    await page.waitForTimeout(2500)
    expect(await page.locator('.feed').innerText()).toBe(frozen)
    await page.getByRole('button', { name: '继续翻译', exact: true }).click()
    await expect(page.locator('.status-pill')).toContainText('Listening', { timeout: 10000 })
    await page.getByRole('button', { name: '结束', exact: true }).click()
    await expect(page.getByText('已保存到桌面「实译历史记录」', { exact: true })).toBeVisible()
    const files = await readdir(join(desktop, '实译历史记录'))
    expect(files).toHaveLength(1)
    const text = await readFile(join(desktop, '实译历史记录', files[0]), 'utf8')
    expect(text).not.toContain('模拟数据')
    expect(text).toContain('15')
    expect(errors).toEqual([])
    await page.screenshot({ path: 'outputs/local-runtime-evaluation/desktop-local.png' })
  } finally {
    await app.close()
    await rm(desktop, { recursive: true, force: true })
  }
})
