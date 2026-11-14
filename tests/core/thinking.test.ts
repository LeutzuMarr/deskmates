import { describe, it, expect } from 'vitest'
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'
import { EventBus } from '../../src/core/events'
import { LiveTimeline } from '../../src/core/engine/live'
import { buildTimeline } from '../../src/core/engine/timeline'
import { sharesThoughts } from '../../src/core/engine/runner'
import type { CoreEvent, TimelineItem } from '../../src/shared/protocol'

function liveItems(parts: object[]): TimelineItem[] {
  const bus = new EventBus()
  const latest = new Map<string, TimelineItem>()
  bus.on((event: CoreEvent) => {
    if (event.type === 'task.item') latest.set(event.item.id, event.item)
  })
  let clock = 0
  const live = new LiveTimeline('t1', bus, () => (clock += 100))
  for (const part of parts) live.apply(part as TextStreamPart<ToolSet>)
  live.flush()
  return [...latest.values()]
}

describe('thinking in the timeline', () => {
  it('streams reasoning as one thinking item, ahead of the answer', () => {
    const items = liveItems([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', text: 'Let me look ' },
      { type: 'reasoning-delta', id: 'r', text: 'at the files.' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 'x', text: 'Done.' }
    ])
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'assistant'])
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'Let me look at the files.' })
  })

  it('ends a thought when a tool is called, so the next thought is its own item', () => {
    const items = liveItems([
      { type: 'reasoning-delta', text: 'First.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } },
      { type: 'start-step' },
      { type: 'reasoning-delta', text: 'Second.' }
    ])
    expect(items.filter((i) => i.kind === 'thinking').map((i) => (i as { text: string }).text)).toEqual(['First.', 'Second.'])
  })

  it('ignores empty reasoning', () => {
    expect(liveItems([{ type: 'reasoning-delta', text: '' }, { type: 'reasoning-end' }])).toEqual([])
  })

  it('rebuilds stored reasoning parts as thinking items', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Plan the change.' },
        { type: 'text', text: 'Here it is.' }
      ]
    } as unknown as ModelMessage
    const items = buildTimeline([{ message, at: 5 }])
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'assistant'])
    expect(items[0].id).not.toBe(items[1].id)
  })
})

describe('sharesThoughts', () => {
  it('asks only thinking Gemini models for their thoughts', () => {
    expect(sharesThoughts('google', 'gemini-2.5-pro')).toBe(true)
    expect(sharesThoughts('google', 'gemini-3-flash-preview')).toBe(true)
    expect(sharesThoughts('google', 'gemini-2.0-flash')).toBe(false)
    expect(sharesThoughts('google', 'gemini-2.5-flash-image')).toBe(false)
    expect(sharesThoughts('openai', 'gemini-2.5-pro')).toBe(false)
  })
})
