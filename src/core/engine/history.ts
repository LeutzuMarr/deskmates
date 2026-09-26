/**
 * History compaction for the message array sent to the model.
 * Shortens old tool outputs and drops the oldest turns when the total is too large.
 */
import type { ModelMessage } from 'ai'

export interface CompactHistoryOptions {
  keepRecentTurns?: number
  maxOldOutputChars?: number
  maxTotalChars?: number
}

/**
 * Returns a compacted copy of the messages array. Never mutates the input.
 *
 * Defaults: keepRecentTurns=2, maxOldOutputChars=2000, maxTotalChars=400_000.
 */
export function compactHistory(messages: ModelMessage[], options?: CompactHistoryOptions): ModelMessage[] {
  const keepRecentTurns = options?.keepRecentTurns ?? 2
  const maxOldOutputChars = options?.maxOldOutputChars ?? 2000
  const maxTotalChars = options?.maxTotalChars ?? 400_000

  // Deep clone to avoid mutation
  let result: ModelMessage[] = JSON.parse(JSON.stringify(messages))

  // Identify turn boundaries (each user message starts a new turn)
  const turnStarts: number[] = []
  for (let i = 0; i < result.length; i++) {
    if ((result[i] as any).role === 'user') {
      turnStarts.push(i)
    }
  }

  // Find the cutoff: messages before the keepRecentTurns-th user message from the end
  const cutoffTurnIdx = turnStarts.length - keepRecentTurns
  const cutoffMsgIdx = cutoffTurnIdx >= 0 && cutoffTurnIdx < turnStarts.length ? turnStarts[cutoffTurnIdx] : result.length

  // Shorten old tool outputs in messages before the cutoff
  for (let i = 0; i < cutoffMsgIdx; i++) {
    const msg = result[i] as any
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j]
        if (part.type === 'tool-result' && part.output !== undefined) {
          const serialized = JSON.stringify(part.output)
          if (serialized.length > maxOldOutputChars) {
            msg.content[j] = {
              ...part,
              output: {
                type: 'text',
                value: '[Shortened output from an earlier step] ' + serialized.slice(0, maxOldOutputChars)
              }
            }
          }
        }
      }
    }
  }

  // Drop oldest turns while total is too large and more than one turn remains
  while (JSON.stringify(result).length > maxTotalChars) {
    // Recompute turn starts on current result
    const currentTurnStarts: number[] = []
    for (let i = 0; i < result.length; i++) {
      if ((result[i] as any).role === 'user') {
        currentTurnStarts.push(i)
      }
    }
    if (currentTurnStarts.length <= 1) break

    // Drop everything from the start up to (but not including) the next user message
    const secondTurnStart = currentTurnStarts[1]
    result = result.slice(secondTurnStart)
  }

  return result
}
