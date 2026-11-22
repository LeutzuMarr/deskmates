import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { buildTimeline, freebuffReplyContent } from '../../src/core/engine/timeline'
import { groupWork, replyParts } from '../../src/core/terminals/freebuff-host'

// A real Freebuff reply (November 2026), as Freebuff's screen gave it.
const REPLY = [
  '• Read .deskmates/freebuff-instructions.md',
  '',
  '• Thinking',
  "Now answer casually, honestly. Note the file calls me Claude but I'm Buffy on Freebuff DeepSeek",
  'V4.1 Flash Slow. Keep short.',
  '',
  'Read the whole instructions file, the operating prompt and the environment notes. Nothing needs',
  'doing yet, so:',
  '',
  "Hey! I'm Buffy, the coding agent in Freebuff.",
  '',
  'What are we building or fixing?'
].join('\n')

describe("Freebuff's steps apart from its answer", () => {
  it('keeps what Freebuff thinks together as one step', () => {
    expect(groupWork(['• Thinking', 'first line of thought', 'second line', '', 'The answer.'])).toEqual([
      '• Thinking first line of thought second line',
      'The answer.'
    ])
  })

  it('splits a reply into its steps and one answer', () => {
    const parts = replyParts(REPLY)
    expect(parts.map((part) => part.step)).toEqual([true, true, false])
    expect(parts[0]!.text).toBe('• Read .deskmates/freebuff-instructions.md')
    expect(parts[1]!.text).toMatch(/^• Thinking Now answer casually.*Keep short\.$/)
    expect(parts[2]!.text).toMatch(/^Read the whole instructions file.*\n\nHey! I'm Buffy.*\n\nWhat are we building or fixing\?$/s)
  })

  it('shows the steps as steps and the answer as the message, after a reload too', () => {
    const message = { role: 'assistant', content: freebuffReplyContent(REPLY) } as ModelMessage
    const items = buildTimeline([{ message: { role: 'user', content: 'yo' }, at: 1 }, { message, at: 2 }])
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'tool', 'assistant'])
    const answer = items[3]
    expect(answer?.kind === 'assistant' && answer.text).not.toContain('• Read')
    expect(items[1]).toMatchObject({ toolName: 'freebuff', state: 'done', input: { activity: '• Read .deskmates/freebuff-instructions.md' } })
  })

  it('stores a reply with no steps as plain text', () => {
    expect(freebuffReplyContent('Just an answer.')).toBe('Just an answer.')
  })
})
