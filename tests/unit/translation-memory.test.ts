import { describe, expect, it } from 'vitest'
import { TranslationMemory } from '../../electron/translation-memory'

const signal = () => new AbortController().signal
function translator() {
  const inputs: string[] = []
  return {
    inputs,
    translate: async (text: string) => {
      inputs.push(text)
      return `译:${text}`
    },
  }
}

describe('TranslationMemory', () => {
  it('reuses completed sentences and translates only an added sentence', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high.', true, signal(), model.translate)
    expect(
      await memory.translate('Costs are high. Returns rise.', true, signal(), model.translate),
    ).toBe('译:Costs are high.\n译:Returns rise.')
    expect(model.inputs).toEqual(['Costs are high.', 'Returns rise.'])
  })

  it('retranslates revised source units while reusing an unchanged sentence', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high. Returns rise.', true, signal(), model.translate)
    await memory.translate('Costs are low. Returns rise.', true, signal(), model.translate)
    expect(model.inputs).toEqual(['Costs are high.', 'Returns rise.', 'Costs are low.'])
  })

  it('keeps source words and terminology settings while ignoring formatting whitespace in cache keys', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high.', true, signal(), model.translate)
    await memory.translate('Costs are high.', false, signal(), model.translate)
    await memory.translate('Costs  are high.', false, signal(), model.translate)
    expect(model.inputs).toEqual(['Costs are high.', 'Costs are high.'])
  })

  it('reuses only the most recent exact whole text for an unchanged open Partial and Final', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high. Returns', true, signal(), model.translate)
    await memory.translate('Costs are high. Returns', true, signal(), model.translate)
    await memory.translate('Costs are high. Returns rise', true, signal(), model.translate)
    await memory.translate('Costs are high. Returns', true, signal(), model.translate)
    expect(model.inputs).toEqual(['Costs are high.', 'Returns', 'Returns rise', 'Returns'])
  })

  it.each([
    [
      'Dr. Smith met Mr. Jones. Costs are 3.14 dollars.',
      ['Dr. Smith met Mr. Jones.', 'Costs are 3.14 dollars.'],
    ],
    ['Use e.g. apples, i.e. fruit. It works.', ['Use e.g. apples, i.e. fruit.', 'It works.']],
    [
      'A. B. Smith lives in the U.S. today. We agree.',
      ['A. B. Smith lives in the U.S. today.', 'We agree.'],
    ],
    ['Ph.D. students work here. They agree.', ['Ph.D. students work here.', 'They agree.']],
    ['Wait... maybe later. Now go!', ['Wait... maybe later.', 'Now go!']],
    ['Wait… maybe later. Now go!', ['Wait… maybe later.', 'Now go!']],
    ['He said "Yes." Then left.', ['He said "Yes."', 'Then left.']],
    ['Ready?! Go. 未完成', ['Ready?!', 'Go.', '未完成']],
    ['首句。下一句！尾句', ['首句。', '下一句！', '尾句']],
  ])('splits conservatively without losing content: %s', async (text, expected) => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate(text, true, signal(), model.translate)
    expect(model.inputs).toEqual(expected)
  })

  it('does not treat an ellipsis or abbreviation at the end as a stable sentence', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Wait...', true, signal(), model.translate)
    await memory.translate('Ask Dr.', true, signal(), model.translate)
    await memory.translate('Wait...', true, signal(), model.translate)
    expect(model.inputs).toEqual(['Wait...', 'Ask Dr.', 'Wait...'])
  })

  it('publishes a cached prefix immediately and preserves it through tail progress', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high.', true, signal(), model.translate)
    const progress: string[] = []
    const output = await memory.translate(
      'Costs are high. Returns rise.',
      true,
      signal(),
      async (text, _terms, _signal, onProgress) => {
        expect(progress).toEqual(['译:Costs are high.'])
        expect(text).toBe('Returns rise.')
        onProgress?.('回报')
        onProgress?.('回')
        return '回报上升。'
      },
      (zh) => progress.push(zh),
    )
    expect(progress).toEqual([
      '译:Costs are high.',
      '译:Costs are high.\n回报',
      '译:Costs are high.\n回',
      '译:Costs are high.\n回报上升。',
    ])
    expect(output).toBe('译:Costs are high.\n回报上升。')
  })

  it('clears both completed sentences and the most recent open result between sessions', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('Costs are high. Returns', true, signal(), model.translate)
    memory.clear()
    await memory.translate('Costs are high. Returns', true, signal(), model.translate)
    expect(model.inputs).toEqual(['Costs are high.', 'Returns', 'Costs are high.', 'Returns'])
  })

  it('does not commit earlier sentence translations when a later unit fails', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await expect(
      memory.translate('Costs are high. Returns rise.', true, signal(), async (text) => {
        if (text === 'Returns rise.') throw new Error('failed')
        return '旧译文'
      }),
    ).rejects.toThrow('failed')
    expect(await memory.translate('Costs are high.', true, signal(), model.translate)).toBe(
      '译:Costs are high.',
    )
    expect(model.inputs).toEqual(['Costs are high.'])
  })

  it.each(['', ' \n\t', undefined])(
    'rejects an invalid native result and retries the same sentence: %s',
    async (invalid) => {
      const memory = new TranslationMemory(),
        model = translator()
      await expect(
        memory.translate(
          'Costs are high.',
          true,
          signal(),
          async () => invalid as unknown as string,
        ),
      ).rejects.toThrow()
      expect(await memory.translate('Costs are high.', true, signal(), model.translate)).toBe(
        '译:Costs are high.',
      )
      expect(model.inputs).toEqual(['Costs are high.'])
    },
  )

  it('does not cache any unit when a later native translation is empty', async () => {
    const memory = new TranslationMemory(),
      model = translator(),
      progress: string[] = []
    await expect(
      memory.translate(
        'Costs are high. Returns rise.',
        true,
        signal(),
        async (text) => (text === 'Costs are high.' ? '旧成本译文' : '   '),
        (zh) => progress.push(zh),
      ),
    ).rejects.toThrow()
    expect(progress).toEqual(['旧成本译文'])
    expect(
      await memory.translate('Costs are high. Returns rise.', true, signal(), model.translate),
    ).toBe('译:Costs are high.\n译:Returns rise.')
    expect(model.inputs).toEqual(['Costs are high.', 'Returns rise.'])
  })

  it.each(['abort', 'clear'] as const)(
    'blocks late progress and cache writes after %s even when the model ignores cancellation',
    async (cancel) => {
      const memory = new TranslationMemory(),
        controller = new AbortController(),
        model = translator()
      const progress: string[] = []
      let finish!: (text: string) => void, lateProgress!: (text: string) => void
      const pending = memory.translate(
        'Costs are high.',
        true,
        controller.signal,
        (_text, _terms, _signal, onProgress) =>
          new Promise<string>((resolve) => {
            finish = resolve
            lateProgress = onProgress!
          }),
        (zh) => progress.push(zh),
      )
      if (cancel === 'abort') controller.abort()
      else memory.clear()
      lateProgress('过期')
      finish('过期')
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(progress).toEqual([])
      expect(await memory.translate('Costs are high.', true, signal(), model.translate)).toBe(
        '译:Costs are high.',
      )
      expect(model.inputs).toEqual(['Costs are high.'])
    },
  )

  it('cannot overwrite a new session result when old work finishes after clear', async () => {
    const memory = new TranslationMemory()
    let finish!: (text: string) => void
    const old = memory.translate(
      'Costs are high.',
      true,
      signal(),
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    memory.clear()
    await memory.translate('Costs are high.', true, signal(), async () => '新会话')
    finish('旧会话')
    await expect(old).rejects.toMatchObject({ name: 'AbortError' })
    expect(await memory.translate('Costs are high.', true, signal(), async () => '不应调用')).toBe(
      '新会话',
    )
  })

  it('rejects an already aborted signal even for a cached result', async () => {
    const memory = new TranslationMemory(),
      model = translator(),
      controller = new AbortController()
    await memory.translate('Costs are high.', true, signal(), model.translate)
    controller.abort()
    const progress: string[] = []
    await expect(
      memory.translate('Costs are high.', true, controller.signal, model.translate, (text) =>
        progress.push(text),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toEqual([])
    expect(model.inputs).toEqual(['Costs are high.'])
  })

  it('suppresses model progress callbacks after their unit completes', async () => {
    const memory = new TranslationMemory(),
      progress: string[] = []
    let lateProgress!: (text: string) => void
    await memory.translate(
      'Costs are high.',
      true,
      signal(),
      async (_text, _terms, _signal, onProgress) => {
        lateProgress = onProgress!
        return '成本很高。'
      },
      (text) => progress.push(text),
    )
    lateProgress('过期')
    expect(progress).toEqual(['成本很高。'])
  })

  it('does not let a completed unit callback replace progress from the following unit', async () => {
    const memory = new TranslationMemory(),
      progress: string[] = []
    let firstProgress!: (text: string) => void
    const zh = await memory.translate(
      'Costs are high. Returns rise.',
      true,
      signal(),
      async (text, _terms, _signal, onProgress) => {
        if (text === 'Costs are high.') {
          firstProgress = onProgress!
          return '成本很高。'
        }
        onProgress?.('回报')
        firstProgress('迟到的成本')
        return '回报上升。'
      },
      (text) => progress.push(text),
    )
    expect(progress).toEqual(['成本很高。', '成本很高。\n回报', '成本很高。\n回报上升。'])
    expect(zh).toBe('成本很高。\n回报上升。')
  })

  it('evicts old closed units after 128 entries and bounds whole-text reuse to one result', async () => {
    const memory = new TranslationMemory(),
      model = translator()
    await memory.translate('First sentence.', true, signal(), model.translate)
    for (let i = 0; i < 128; i++)
      await memory.translate(`Sentence ${i}.`, true, signal(), model.translate)
    model.inputs.length = 0
    await memory.translate('First sentence.', true, signal(), model.translate)
    await memory.translate('Sentence 127.', true, signal(), model.translate)
    expect(model.inputs).toEqual(['First sentence.'])
  })
})

it('reuses a complete sentence across ASR whitespace changes without changing words or numbers', async () => {
  const memory = new TranslationMemory(),
    model = translator()
  const first = await memory.translate('Costs are 15 dollars.', true, signal(), model.translate)
  expect(await memory.translate('Costs  are 15\n dollars.', true, signal(), model.translate)).toBe(
    first,
  )
  await memory.translate('Costs are 50 dollars.', true, signal(), model.translate)
  await memory.translate('Costs are not 15 dollars.', true, signal(), model.translate)
  expect(model.inputs).toEqual([
    'Costs are 15 dollars.',
    'Costs are 50 dollars.',
    'Costs are not 15 dollars.',
  ])
})

it('announces a closed unit before the next native unit finishes and replays units on exact reuse', async () => {
  const memory = new TranslationMemory()
  const progress: Array<{ zh: string; units: any }> = []
  let finish!: (zh: string) => void
  const job = memory.translate(
    'Costs are high. Returns rise.',
    true,
    signal(),
    async (text) => {
      if (text === 'Costs are high.') return '成本很高。'
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
    (zh, units) => progress.push({ zh, units }),
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(progress[0]).toEqual({
    zh: '成本很高。',
    units: [{ source: 'Costs are high.', zh: '成本很高。' }],
  })
  finish('回报上升。')
  await job
  expect(progress[0].units).toHaveLength(1)
  const replay: any[] = []
  await memory.translate(
    'Costs are high. Returns rise.',
    true,
    signal(),
    async () => {
      throw new Error('cached')
    },
    (zh, units) => replay.push({ zh, units }),
  )
  expect(replay[0].units).toEqual([
    { source: 'Costs are high.', zh: '成本很高。' },
    { source: 'Returns rise.', zh: '回报上升。' },
  ])
})

it('does not describe a completed but open native tail as a closed sentence unit', async () => {
  const memory = new TranslationMemory(),
    events: any[] = []
  await memory.translate(
    'Costs are high. Returns',
    true,
    signal(),
    async (text) => '译:' + text,
    (zh, units) => events.push({ zh, units }),
  )
  expect(events.at(-1).units).toEqual([{ source: 'Costs are high.', zh: '译:Costs are high.' }])
})
