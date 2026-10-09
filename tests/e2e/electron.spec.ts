import { test, expect, _electron as electron } from '@playwright/test'
test('桌面启动、隔离与剪贴板', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '开始翻译', exact: true })).toBeVisible()
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
    await page.getByRole('button', { name: '开始翻译', exact: true }).click()
    await expect(page.locator('.caption.final').first()).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '复制全部', exact: true }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('AI')
    await page.screenshot({ path: 'work/screenshots/desktop.png' })
  } finally {
    await app.close()
  }
})

test('桌面结束自动落盘，失败后重试成功，清空不删历史', async () => {
  const { mkdtemp, readdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const desktop = await mkdtemp(join(tmpdir(), 'shiyi-desktop-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    await app.evaluate(({ app }, dir) => app.setPath('desktop', dir), desktop)
    const page = await app.firstWindow()
    await page.clock.install()
    await page.getByRole('button', { name: '开始翻译', exact: true }).click()
    await page.clock.runFor(5000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const directory = join(desktop, '实译历史记录')
    await writeFile(directory, '阻止创建目录')
    await page.getByRole('button', { name: '结束', exact: true }).click()
    await expect(page.getByText('保存失败，记录仍在当前页面，请重试或下载备份')).toBeVisible()
    await expect(page.locator('.caption.final')).toHaveCount(1)
    await rm(directory)
    await page.getByRole('button', { name: '重试保存' }).click()
    await expect(page.getByText('已保存到桌面「实译历史记录」', { exact: true })).toBeVisible()
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    const content = await readFile(join(directory, files[0]), 'utf8')
    expect(content).toContain('模拟数据')
    expect(content).toContain('Today')
    expect(content).toContain('今天')
    await page.getByRole('button', { name: '清空记录' }).click()
    await page.getByRole('button', { name: '确认清空' }).click()
    expect(await readdir(directory)).toEqual(files)
    await page.getByRole('button', { name: '重新开始', exact: true }).click()
    await page.clock.runFor(60000)
    await expect(page.getByText('已保存到桌面「实译历史记录」', { exact: true })).toBeVisible()
    expect(await readdir(directory)).toHaveLength(2)
  } finally {
    await app.close()
    await rm(desktop, { recursive: true, force: true })
  }
})
