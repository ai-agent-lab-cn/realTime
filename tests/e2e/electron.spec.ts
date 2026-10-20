import { test, expect, _electron as electron } from '@playwright/test'
test('桌面启动、隔离与剪贴板', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    const page = await app.firstWindow()
    await page.getByLabel('音频来源').selectOption('demo')
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
    await page.getByLabel('音频来源').selectOption('demo')
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

test('英文识别回执不等待翻译，独立通知保留最终结果', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    await app.evaluate(async () => {
      // Replace only external model inference; real runtime, IPC and preload are exercised.
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(process.cwd() + '/package.json')
      const { NativeModels } = require('./dist-electron/local-models.js')
      let n = 0
      NativeModels.prototype.prepare = async () => {}
      NativeModels.prototype.recognize = async () =>
        ++n === 1 ? 'Costs are high.' : 'Returns rise.'
      NativeModels.prototype.translate = async (
        text: string,
        _terms: boolean,
        signal: AbortSignal,
        progress?: (s: string) => void,
      ) => {
        if (text === 'Costs are high.') {
          progress?.('成本')
          await new Promise<void>((resolve) => {
            ;(globalThis as any).__releaseMT = resolve
          })
        }
        signal.throwIfAborted()
        return text === 'Costs are high.' ? '成本很高。' : '回报增加。'
      }
    })
    const page = await app.firstWindow()
    const ack = await page.evaluate(async () => {
      const local = window.desktop!.local!
      const events: any[] = []
      ;(window as any).__pipelineEvents = events
      local.onRecognized!((e) => events.push({ type: 'asr', ...e }))
      local.onTranslated!((e) => events.push({ type: 'mt', ...e }))
      const token = crypto.randomUUID()
      await local.prepare(token)
      const input = {
        token,
        id: 0,
        revision: 1,
        time: 0,
        final: true,
        terms: false,
        pcm: new Float32Array(16000).buffer,
      }
      const first = await local.recognize!(input)
      const second = await local.recognize!({ ...input, id: 1, time: 2 })
      return {
        first,
        second,
        completed: events.filter((e) => e.phase === 'complete').length,
      }
    })
    // invoke replies and pushed events use separate IPC channels. Both ASR
    // notifications must arrive while MT remains held, regardless of delivery order.
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__pipelineEvents
            .filter((e: any) => e.type === 'asr')
            .map((e: any) => e.en),
        ),
      )
      .toEqual(['Costs are high.', 'Returns rise.'])
    expect(ack.completed).toBe(0)
    expect(ack.first.pending).toBe(true)
    expect(ack.second.pending).toBe(true)
    await app.evaluate(() => (globalThis as any).__releaseMT())
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__pipelineEvents
            .filter((e: any) => e.phase === 'complete')
            .map((e: any) => e.zh),
        ),
      )
      .toEqual(['成本很高。', '回报增加。'])
  } finally {
    await app.close()
  }
})

test('分句完成先更新页面，阶段计时只保存数值且实际落盘',async()=>{
  const {mkdtemp,readFile,rm,mkdir,writeFile}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const root=await mkdtemp(join(tmpdir(),'shiyi-unit-timing-'))
  const app=await electron.launch({args:['.','--use-fake-device-for-media-stream'],env:{...process.env,VITE_DEV_SERVER_URL:'',SHIYI_DIAGNOSTIC_SOURCE:'fixture'}})
  try{
    await app.evaluate(({app},dir)=>{app.setPath('userData',dir);app.setPath('desktop',dir)},root)
    await app.evaluate(()=>{
      const require=process.getBuiltinModule('node:module').createRequire(process.cwd()+'/package.json')
      const {NativeModels}=require('./dist-electron/local-models.js')
      let calls=0
      NativeModels.prototype.prepare=async()=>{}
      NativeModels.prototype.recognize=async()=>++calls===1?'Costs are high. Returns fall.':'Costs are high. Returns rise. Growth continues.'
      NativeModels.prototype.translate=async(text:string)=>{
        if(text==='Growth continues.'){
          ;(globalThis as any).__thirdStarted=true
          return new Promise<string>(resolve=>{(globalThis as any).__releaseThird=()=>resolve('增长继续。')})
        }
        return text==='Costs are high.'?'成本很高。':text==='Returns fall.'?'回报下降。':'回报上升。'
      }
    })
    const page=await app.firstWindow()
    await page.addInitScript(()=>{
      navigator.mediaDevices.getUserMedia=async()=>{
        const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination()
        gain.gain.value=0.1;oscillator.connect(gain);gain.connect(destination)
        await context.resume();oscillator.start()
        for(const track of destination.stream.getTracks()){
          const stop=track.stop.bind(track)
          track.stop=()=>{stop();oscillator.stop();void context.close()}
        }
        return destination.stream
      }
    })
    await page.reload()
    await page.getByRole('button',{name:'开始翻译',exact:true}).click()
    await expect(page.locator('.caption .chinese').first()).toContainText('回报下降。',{timeout:15000})
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).__thirdStarted===true)).toBe(true)
    await expect(page.locator('.caption .chinese').first()).toContainText('回报上升。')
    await expect(page.locator('.caption .chinese').first()).not.toContainText('增长继续。')
    await expect(page.locator('.caption.final')).toHaveCount(0)
    await expect.poll(()=>page.evaluate(async()=>(await window.desktop!.local!.diagnostics!()).report?.summary.speechToChineseMs?.n??0)).toBeGreaterThan(0)
    const before=await page.evaluate(async()=>window.desktop!.local!.diagnostics!())
    expect(before.report?.summary.asrMs?.n).toBeGreaterThan(0)
    expect(before.report?.summary.mtFirstMs?.n).toBeGreaterThan(0)
    await page.getByRole('button',{name:'暂停',exact:true}).click()
    await expect.poll(()=>page.evaluate(async()=>(await window.desktop!.local!.diagnostics!()).savedPath??'')).not.toBe('')
    const saved=await page.evaluate(async()=>window.desktop!.local!.diagnostics!())
    expect(saved.savedPath!.startsWith(join(root,'diagnostics'))).toBe(true)
    const body=await readFile(saved.savedPath!,'utf8')
    expect(body).not.toContain('Costs');expect(body).not.toContain('成本');expect(body).not.toContain('"token"')
    expect(JSON.parse(body).source).toBe('fixture')
    expect(JSON.parse(body).finished).toBe(true)
    await mkdir('outputs/unit-timings',{recursive:true})
    await writeFile('outputs/unit-timings/desktop-diagnostics.json',body)
    await page.screenshot({path:'work/screenshots/unit-completed.png'})
    await app.evaluate(()=>(globalThis as any).__releaseThird())
  }finally{await app.close();await rm(root,{recursive:true,force:true})}
})

test('保存旧计时期间取消准备不会启动新模型会话',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const root=await mkdtemp(join(tmpdir(),'shiyi-prepare-timing-'))
  const app=await electron.launch({args:['.'],env:{...process.env,VITE_DEV_SERVER_URL:'',SHIYI_DIAGNOSTIC_SOURCE:'fixture'}})
  try{
    await app.evaluate(({app},dir)=>app.setPath('userData',dir),root)
    await app.evaluate(()=>{
      const require=process.getBuiltinModule('node:module').createRequire(process.cwd()+'/package.json')
      const {NativeModels}=require('./dist-electron/local-models.js')
      ;(globalThis as any).__prepareCount=0
      NativeModels.prototype.prepare=async()=>{(globalThis as any).__prepareCount++}
      NativeModels.prototype.recognize=async()=> 'Hello.'
      NativeModels.prototype.translate=async()=> '你好。'
    })
    const page=await app.firstWindow()
    await page.evaluate(async()=>{
      const local=window.desktop!.local!,token='11111111-1111-4111-8111-111111111111'
      await local.prepare(token)
      await local.recognize!({token,id:0,revision:1,final:true,time:0,terms:false,pcm:new Float32Array(16000).buffer})
    })
    await expect.poll(()=>page.evaluate(async()=>(await window.desktop!.local!.diagnostics!()).report?.requests[0]?.stages.complete!==undefined)).toBe(true)
    await app.evaluate(()=>{
      const require=process.getBuiltinModule('node:module').createRequire(process.cwd()+'/package.json')
      const fs=require('node:fs/promises'),modules=require('node:module'),original=fs.writeFile
      fs.writeFile=async(...args:any[])=>{
        ;(globalThis as any).__saveWaiting=true
        await new Promise<void>(resolve=>{(globalThis as any).__releaseSave=resolve})
        fs.writeFile=original;modules.syncBuiltinESMExports()
        return original(...args)
      }
      modules.syncBuiltinESMExports()
    })
    await page.evaluate(()=>{
      ;(window as any).__prepareResult=window.desktop!.local!.prepare('22222222-2222-4222-8222-222222222222').then(()=> 'ready',()=> 'cancelled')
    })
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).__saveWaiting===true)).toBe(true)
    await page.evaluate(()=>window.desktop!.local!.cancel('22222222-2222-4222-8222-222222222222'))
    await app.evaluate(()=>(globalThis as any).__releaseSave())
    expect(await page.evaluate(()=>(window as any).__prepareResult)).toBe('cancelled')
    expect(await app.evaluate(()=>(globalThis as any).__prepareCount)).toBe(1)
  }finally{await app.close();await rm(root,{recursive:true,force:true})}
})
