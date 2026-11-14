import { describe, expect, it } from 'vitest'
import { quickReplies } from '../../src/shared/quick-replies'

describe('quick replies', () => {
  it('reads a question followed by numbered options', () => {
    const reply = 'I found three hotels.\n\nWhich should I pitch first?\n1. **Hotel Roma** — 4 stars, no chatbot\n2. Hotel Milano\n3. Skip hotels today'
    expect(quickReplies(reply)).toEqual({ question: 'Which should I pitch first?', options: ['Hotel Roma — 4 stars, no chatbot', 'Hotel Milano', 'Skip hotels today'] })
  })

  it('reads options followed by the question', () => {
    const reply = 'Two ways to do it:\n- Send them now\n- Wait until Monday\n\nWhich do you prefer?'
    expect(quickReplies(reply)).toEqual({ question: 'Which do you prefer?', options: ['Send them now', 'Wait until Monday'] })
  })

  it('cuts long explanations down to the label', () => {
    const reply = 'What next?\n1. Approve all: sends the ten drafts to the companies listed above right now\n2. Review one by one'
    expect(quickReplies(reply)?.options).toEqual(['Approve all', 'Review one by one'])
  })

  it('ignores lists that are not a question to the user', () => {
    expect(quickReplies('Done. I changed:\n1. the header\n2. the footer')).toBeNull()
    expect(quickReplies('Should I go on?')).toBeNull()
    expect(quickReplies('Pick one?\n1. only one')).toBeNull()
  })
})
