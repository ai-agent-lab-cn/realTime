import { describe, expect, it } from 'vitest'
import { command, createSession } from '../../src/domain/session'
import { LocalCaptionUpdates } from '../../src/domain/localCaptions'

function setup() {
  const session = createSession()
  command(session, 'start')
  return { session, updates: new LocalCaptionUpdates(session), epoch: session.epoch }
}
const segment = (revision: number, final = false, id = 0) => ({ id, revision, final, time: id })

describe('independent local captions', () => {
  it('updates English immediately while retaining prior Chinese and normalizes checked punctuation', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
    updates.recognize(segment(2), { en: 'Costs are high. Returns rise', zh: '' }, epoch)
    expect(session.captions[0]).toMatchObject({
      en: 'Costs are high. Returns rise',
      zh: '成本很高。',
      final: false,
    })
    updates.recognize(segment(2), { en: 'Costs are high. Returns rise.', zh: '' }, epoch, true)
    expect(session.captions[0].en).toBe('Costs are high. Returns rise.')
  })
  it('retains Chinese during a shorter or different new stream and replaces on completion', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
    updates.recognize(segment(2), { en: 'Costs are lower.', zh: '' }, epoch, true)
    updates.translate(segment(2), { en: 'Costs are lower.', zh: '费用' }, epoch, false)
    expect(session.captions[0].zh).toBe('成本很高。')
    updates.translate(segment(2), { en: 'Costs are lower.', zh: '成本降低。' }, epoch, true)
    expect(session.captions[0].zh).toBe('成本降低。')
  })
  it('accepts useful older Chinese without rolling English back or prematurely finalizing', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.recognize(
      segment(2, true),
      { en: 'Costs are high. Returns rise.', zh: '' },
      epoch,
      true,
    )
    updates.translate(segment(1, true), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
    expect(session.captions[0]).toMatchObject({
      en: 'Costs are high. Returns rise.',
      zh: '成本很高。',
      final: false,
    })
    updates.translate(
      segment(2, true),
      { en: 'Costs are high. Returns rise.', zh: '成本很高。回报增长。' },
      epoch,
      true,
    )
    expect(session.captions[0].final).toBe(true)
    updates.recognize(segment(3), { en: 'Do not rewrite.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Old.', zh: '旧译文' }, epoch, true)
    expect(session.captions[0]).toMatchObject({
      en: 'Costs are high. Returns rise.',
      zh: '成本很高。回报增长。',
      final: true,
    })
  })
  it('rejects older translations after a newer accepted one and supports terminology normalization', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(2), { en: 'Use a pull request.', zh: '' }, epoch, true)
    updates.translate(segment(2), { en: 'Use a pull request.', zh: '使用 pull' }, epoch, false)
    updates.translate(
      segment(2),
      { en: 'Use a pull request.', zh: '使用 Pull Request 提交变更' },
      epoch,
      false,
    )
    updates.translate(segment(1), { en: 'Use.', zh: '使用旧版本。' }, epoch, true)
    expect(session.captions[0].zh).toBe('使用 Pull Request 提交变更')
  })
  it('routes carry revisions to the old caption and isolates epochs', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1, true), { en: 'The projects', zh: '', pending: true }, epoch, true)
    const caption = { id: 0, revision: 10, time: 0 }
    updates.recognize(
      segment(1, true, 1),
      { en: 'The projects succeed.', zh: '', caption },
      epoch,
      true,
    )
    updates.translate(
      segment(1, true, 1),
      { en: 'The projects succeed.', zh: '项目成功。', caption },
      epoch,
      true,
    )
    expect(session.captions).toHaveLength(1)
    expect(session.captions[0]).toMatchObject({ final: true, time: 0 })
    command(session, 'pause')
    command(session, 'resume')
    updates.recognize(segment(20, true), { en: 'Late.', zh: '' }, epoch, true)
    expect(session.captions[0].en).toBe('The projects succeed.')
    updates.recognize(segment(1, false, 2), { en: 'New.', zh: '' }, session.epoch, true)
    expect(session.captions.at(-1)?.en).toBe('New.')
  })
  it('keeps rejected provisional English with its reason and removes silent provisional rows', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Repeated text', zh: '' }, epoch)
    updates.recognize(segment(1, true), { en: '', zh: '', error: '重复异常' }, epoch, true)
    expect(session.captions[0]).toMatchObject({
      en: 'Repeated text',
      error: '重复异常',
      final: false,
    })
    updates.recognize(segment(1, false, 1), { en: 'Noise', zh: '' }, epoch)
    updates.recognize(segment(1, true, 1), { en: '', zh: '' }, epoch, true)
    expect(session.captions).toHaveLength(1)
  })
})

it('confirms after a checked ack when cached MT completed before it, without accepting late rewrites', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1, true), { en: 'Hello', zh: '' }, epoch)
  updates.translate(segment(1, true), { en: 'Hello.', zh: '你好。' }, epoch, true)
  expect(session.captions[0].final).toBe(false)
  updates.recognize(
    segment(1, true),
    { en: 'Hello.', zh: '', pending: true, translationQueued: true },
    epoch,
    true,
  )
  expect(session.captions[0]).toMatchObject({ en: 'Hello.', zh: '你好。', final: true })
})

it('retains a translation error when completion precedes its pending ASR acknowledgement', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1, true), { en: 'Hello', zh: '' }, epoch)
  updates.translate(
    segment(1, true),
    { en: 'Hello.', zh: '', error: 'translation failed' },
    epoch,
    true,
  )
  updates.recognize(
    segment(1, true),
    { en: 'Hello.', zh: '', pending: true, translationQueued: true },
    epoch,
    true,
  )
  expect(session.captions[0]).toMatchObject({
    en: 'Hello.',
    error: 'translation failed',
    final: false,
  })
})

it('does not replace a visible translation with a same-request nonmonotonic stream', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: 'Hello.', zh: '' }, epoch, true)
  updates.translate(segment(1), { en: 'Hello.', zh: '你好世界' }, epoch, false)
  updates.translate(segment(1), { en: 'Hello.', zh: '完全不同的译文' }, epoch, false)
  expect(session.captions[0].zh).toBe('你好世界')
})

it('can still display useful older Chinese after the newest translation failed without regressing English or error', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
  updates.recognize(segment(2, true), { en: 'Costs are high. Returns rise.', zh: '' }, epoch, true)
  updates.translate(
    segment(2, true),
    { en: 'Costs are high. Returns rise.', zh: '', error: 'MT failed' },
    epoch,
    true,
  )
  updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
  expect(session.captions[0]).toMatchObject({
    en: 'Costs are high. Returns rise.',
    zh: '成本很高。',
    error: 'MT failed',
    final: false,
  })
})

it('does not display older Chinese after the source corrected a number or negation', () => {
  for (const [older, current] of [
    ['The timeout is fifteen seconds.', 'The timeout is fifty seconds.'],
    ['We should enable backups.', 'We should not enable backups.'],
  ]) {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: older, zh: '' }, epoch, true)
    updates.recognize(segment(2), { en: current, zh: '' }, epoch, true)
    updates.translate(segment(1), { en: older, zh: '已被更正的旧译文' }, epoch, true)
    expect(session.captions[0]).toMatchObject({ en: current, zh: '', final: false })
  }
})

it('does not append an older translation to Chinese retained from a corrected source', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
  updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, false)
  updates.recognize(segment(2), { en: 'Costs are low.', zh: '' }, epoch, true)
  updates.translate(
    segment(1),
    { en: 'Costs are high.', zh: '成本很高。这是旧的补充。' },
    epoch,
    false,
  )
  expect(session.captions[0].zh).toBe('成本很高。')
})

it('rejects an older word fragment that is only a character prefix of a corrected word', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: 'There are fifteen', zh: '' }, epoch, true)
  updates.recognize(segment(2), { en: 'There are fifteenths', zh: '' }, epoch, true)
  updates.translate(
    segment(1),
    { en: 'There are fifteen', zh: '有十五个', pending: true },
    epoch,
    true,
  )
  expect(session.captions[0].zh).toBe('')
})

it('keeps useful older Chinese across source whitespace updates and confirms the newer matching translation', () => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
  updates.recognize(
    segment(2, true),
    { en: 'Costs  are high.\nReturns rise.', zh: '' },
    epoch,
    true,
  )
  updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
  expect(session.captions[0]).toMatchObject({ zh: '成本很高。', final: false })
  updates.translate(
    segment(2, true),
    { en: 'Costs  are high.\nReturns rise.', zh: '成本很高。\n回报上升。' },
    epoch,
    true,
  )
  expect(session.captions[0]).toMatchObject({ zh: '成本很高。\n回报上升。', final: true })
})

it.each([
  ['Costs are 3', 'Costs are 3.14 dollars'],
  ['Costs are 1', 'Costs are 1,000 dollars'],
])('rejects older MT when a numeric token grows: %s', (older, current) => {
  const { session, updates, epoch } = setup()
  updates.recognize(segment(1), { en: older, zh: '' }, epoch, true)
  updates.recognize(segment(2), { en: current, zh: '' }, epoch, true)
  updates.translate(segment(1), { en: older, zh: '错误的整数译文' }, epoch, true)
  expect(session.captions[0].zh).toBe('')
})

describe('completed translation units', () => {
  it('removes an obsolete sentence suffix when the completed replacement is its character prefix', () => {
    const { session, updates, epoch } = setup()
    const older = 'Costs are high. Returns rise quickly.'
    updates.recognize(segment(1), { en: older, zh: '' }, epoch, true)
    updates.translate(segment(1), { en: older, zh: '成本很高。\n回报上升很快' }, epoch, true)
    const en = 'Costs are high. Returns rise. We can invest.'
    const first = { source: 'Costs are high.', zh: '成本很高。' }
    updates.recognize(segment(2), { en, zh: '' }, epoch, true)
    updates.translate(segment(2), { en, zh: first.zh, units: [first] }, epoch, false)
    expect(session.captions[0].zh).toBe('成本很高。\n回报上升很快')
    updates.translate(
      segment(2),
      {
        en,
        zh: '成本很高。\n回报上升\n我们可以',
        units: [first, { source: 'Returns rise.', zh: '回报上升' }],
      },
      epoch,
      false,
    )
    expect(session.captions[0]).toMatchObject({ zh: '成本很高。\n回报上升', final: false })
  })

  it('publishes a newly completed sentence before the remaining native stream completes', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high. Returns fall.', zh: '' }, epoch, true)
    updates.translate(
      segment(1),
      { en: 'Costs are high. Returns fall.', zh: '成本很高。\n回报下降。' },
      epoch,
      true,
    )
    const en = 'Costs are high. Returns rise. We can invest.'
    const first = { source: 'Costs are high.', zh: '成本很高。' }
    const second = { source: 'Returns rise.', zh: '回报上升。' }
    updates.recognize(segment(2), { en, zh: '' }, epoch, true)
    updates.translate(segment(2), { en, zh: first.zh, units: [first] }, epoch, false)
    expect(session.captions[0].zh).toBe('成本很高。\n回报下降。')
    updates.translate(
      segment(2),
      { en, zh: '成本很高。\n回报上升。\n我们可以', units: [first, second] },
      epoch,
      false,
    )
    expect(session.captions[0]).toMatchObject({
      zh: '成本很高。\n回报上升。',
      final: false,
    })
    updates.translate(
      segment(2),
      { en, zh: '成本很高。\n回报上升。\n我们可以投资', units: [first, second] },
      epoch,
      false,
    )
    expect(session.captions[0].zh).toBe('成本很高。\n回报上升。\n我们可以投资')
    updates.translate(segment(2), { en, zh: first.zh, units: [first] }, epoch, false)
    expect(session.captions[0].zh).toBe('成本很高。\n回报上升。\n我们可以投资')
  })

  it('allows a completed corrected first sentence to replace unconfirmed Chinese', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high. Returns rise.', zh: '' }, epoch, true)
    updates.translate(
      segment(1),
      { en: 'Costs are high. Returns rise.', zh: '成本很高。\n回报上升。' },
      epoch,
      true,
    )
    const en = 'Costs are low. Returns rise.'
    updates.recognize(segment(2), { en, zh: '' }, epoch, true)
    updates.translate(
      segment(2),
      { en, zh: '成本降低。', units: [{ source: 'Costs are low.', zh: '成本降低。' }] },
      epoch,
      false,
    )
    expect(session.captions[0]).toMatchObject({ en, zh: '成本降低。', final: false })
  })

  it.each([
    { units: [{ source: 'Costs are high.', zh: '成本降低。' }] },
    { units: [{ source: 'Costs are low.', zh: '' }] },
    { units: [{ source: 'Costs are low.', zh: '不匹配的中文。' }] },
    {
      units: [
        { source: 'Costs are low.', zh: '成本降低。' },
        { source: 'Still waiting', zh: '仍在等待。' },
      ],
    },
  ])('does not use invalid unit metadata to replace a visible translation: %j', ({ units }) => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
    const en = 'Costs are low. Still waiting'
    updates.recognize(segment(2), { en, zh: '' }, epoch, true)
    updates.translate(segment(2), { en, zh: '成本降低。\n仍在等待。', units }, epoch, false)
    expect(session.captions[0].zh).toBe('成本很高。')
  })

  it('accepts exact sentence prefixes with normalized source whitespace', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Costs are high.', zh: '成本很高。' }, epoch, true)
    const en = 'Costs  are low.\nStill waiting'
    updates.recognize(segment(2), { en, zh: '' }, epoch, true)
    updates.translate(
      segment(2),
      { en, zh: '成本降低。', units: [{ source: 'Costs are low.', zh: '成本降低。' }] },
      epoch,
      false,
    )
    expect(session.captions[0].zh).toBe('成本降低。')
  })

  it('keeps accepted units when a shorter same-revision prefix changes its translation', () => {
    const { session, updates, epoch } = setup()
    const en = 'Costs are high. Returns rise.'
    updates.recognize(segment(1), { en, zh: '' }, epoch, true)
    updates.translate(
      segment(1),
      {
        en,
        zh: '成本很高。\n回报上升。',
        units: [
          { source: 'Costs are high.', zh: '成本很高。' },
          { source: 'Returns rise.', zh: '回报上升。' },
        ],
      },
      epoch,
      false,
    )
    updates.translate(
      segment(1),
      { en, zh: '费用很高。', units: [{ source: 'Costs are high.', zh: '费用很高。' }] },
      epoch,
      false,
    )
    expect(session.captions[0].zh).toBe('成本很高。\n回报上升。')
  })

  it('rejects completed metadata that no longer matches the current English prefix', () => {
    const { session, updates, epoch } = setup()
    updates.recognize(segment(1), { en: 'Costs are high.', zh: '' }, epoch, true)
    updates.translate(segment(1), { en: 'Costs are high.', zh: '原有译文。' }, epoch, false)
    updates.recognize(segment(1), { en: 'Costs are low.', zh: '' }, epoch, true)
    updates.translate(
      segment(1),
      {
        en: 'Costs are high.',
        zh: '成本很高。',
        units: [{ source: 'Costs are high.', zh: '成本很高。' }],
      },
      epoch,
      false,
    )
    expect(session.captions[0]).toMatchObject({ en: 'Costs are low.', zh: '原有译文。' })
  })

  it('keeps Finals and a resumed epoch isolated from completed unit updates', () => {
    const { session, updates, epoch } = setup()
    const initial = {
      en: 'Costs are high.',
      zh: '成本很高。',
      units: [{ source: 'Costs are high.', zh: '成本很高。' }],
    }
    const changed = {
      ...initial,
      zh: '费用很高。',
      units: [{ source: initial.en, zh: '费用很高。' }],
    }
    updates.recognize(segment(1, true), { ...initial, zh: '' }, epoch, true)
    updates.translate(segment(1, true), initial, epoch, true)
    updates.translate(segment(2, true), changed, epoch, false)
    expect(session.captions[0]).toMatchObject({ zh: '成本很高。', final: true })
    updates.recognize(segment(1, false, 1), { ...initial, zh: '' }, epoch, true)
    updates.translate(segment(1, false, 1), initial, epoch, false)
    command(session, 'pause')
    command(session, 'resume')
    updates.translate(segment(2, false, 1), changed, epoch, false)
    expect(session.captions[1].zh).toBe('成本很高。')
  })
})
