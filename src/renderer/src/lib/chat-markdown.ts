import { stepLabel } from './steps'
import type { TimelineItem, ToolItem } from '../../../shared/protocol'

/** The chat as Markdown: each message under a heading, the agent's steps as a list. */
export function chatMarkdown(title: string, timeline: TimelineItem[]): string {
  const out: string[] = [`# ${title.trim() || 'Chat'}`, '']
  let steps: string[] = []
  const flushSteps = (): void => {
    if (steps.length) out.push(...steps.map((step) => `- ${step}`), '')
    steps = []
  }
  for (const item of timeline) {
    if (item.kind === 'tool') {
      if (item.toolName === 'narration') {
        flushSteps()
        out.push(String((item.input as { text?: unknown })?.text ?? ''), '')
      } else {
        steps.push(stepLabel(item as ToolItem))
      }
      continue
    }
    flushSteps()
    if (item.kind === 'user') out.push('## You', '', item.text, '')
    else if (item.kind === 'assistant') out.push(item.text, '')
  }
  flushSteps()
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
