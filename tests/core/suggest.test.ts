import { describe, expect, it } from 'vitest'
import { cleanSuggestion, obviousNextMessage, suggestNextMessage } from '../../src/core/engine/suggest'

describe('the suggested next message', () => {
  it('answers a closing question without asking a model', async () => {
    expect(obviousNextMessage('Fixed it. Want me to commit?')).toBe('Yes, go ahead')
    expect(obviousNextMessage('Which one?\n1. The red one\n2. The blue one')).toBe('The red one')
    expect(obviousNextMessage('All done.')).toBeNull()
    const messages = [
      { role: 'user' as const, content: 'fix the header' },
      { role: 'assistant' as const, content: 'Fixed the header. Should I push it?' }
    ]
    expect(await suggestNextMessage(messages, null)).toBe('Yes, go ahead')
  })

  it('has nothing to suggest for a command-line model without a closing question', async () => {
    expect(await suggestNextMessage([{ role: 'assistant', content: 'Here is the summary.' }], null)).toBeNull()
  })

  it('cleans what a model writes into one short message', () => {
    expect(cleanSuggestion('User: "Now add tests"\nmore')).toBe('Now add tests')
    expect(cleanSuggestion('NONE')).toBeNull()
    expect(cleanSuggestion('x'.repeat(200))).toBeNull()
  })
})
