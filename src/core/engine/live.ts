/**
 * LiveTimeline: processes stream parts in real-time and emits timeline items via the event bus.
 */
import type { TextStreamPart, ToolSet } from 'ai'
import type { TimelineItem, ToolItem } from '../../shared/protocol'
import type { EventBus } from '../events'

export class LiveTimeline {
  private readonly taskId: string
  private readonly bus: EventBus
  private readonly now: () => number

  /** Accumulated live items. */
  private items: TimelineItem[] = []
  private toolMap = new Map<string, ToolItem>()

  /** Current text accumulator. */
  private currentTextId: string | null = null
  private currentText = ''
  private textCounter = 0

  /** Throttle for text-delta emissions. */
  private lastEmitTime = 0

  /** Current reasoning accumulator, streamed the same way as text. */
  private thinkingId: string | null = null
  private thinkingText = ''
  private thinkingAt = 0
  private thinkingCounter = 0
  private lastThinkingEmit = 0

  constructor(taskId: string, bus: EventBus, now: () => number) {
    this.taskId = taskId
    this.bus = bus
    this.now = now
  }

  apply(part: TextStreamPart<ToolSet>): void {
    const p = part as any

    switch (p.type) {
      case 'start-step':
        this.flushThinking()
        this.endCurrentText()
        break

      case 'reasoning-delta': {
        const delta: string = p.text ?? p.delta ?? ''
        if (!delta) break
        if (!this.thinkingId) {
          this.thinkingCounter++
          this.thinkingId = `live-think-${this.thinkingCounter}`
          this.thinkingText = ''
          this.thinkingAt = this.now()
        }
        this.thinkingText += delta
        const now = this.now()
        if (now - this.lastThinkingEmit >= 80) {
          this.emitThinking()
          this.lastThinkingEmit = now
        }
        break
      }

      case 'reasoning-end':
        this.flushThinking()
        break

      case 'text-delta': {
        this.flushThinking()
        if (!this.currentTextId) {
          this.textCounter++
          this.currentTextId = `live-${this.textCounter}`
          this.currentText = ''
        }
        this.currentText += p.text ?? p.delta ?? ''

        // Emit at most every 50ms
        const now = this.now()
        if (now - this.lastEmitTime >= 50) {
          this.emitCurrentTextItem()
          this.lastEmitTime = now
        }
        break
      }

      case 'tool-call': {
        this.flushThinking()
        this.flushText()
        const toolItem: ToolItem = {
          kind: 'tool',
          id: p.toolCallId,
          at: this.now(),
          toolName: p.toolName,
          input: p.input,
          state: 'running'
        }
        this.items.push(toolItem)
        this.toolMap.set(p.toolCallId, toolItem)
        this.bus.emit({ type: 'task.item', taskId: this.taskId, item: toolItem })
        break
      }

      case 'tool-approval-request': {
        if (!p.isAutomatic) {
          const toolCallId = p.toolCall?.toolCallId ?? p.toolCallId
          const existing = this.toolMap.get(toolCallId)
          if (existing) {
            existing.state = 'awaiting-approval'
            existing.approvalId = p.approvalId
            this.bus.emit({ type: 'task.item', taskId: this.taskId, item: existing })
          }
        }
        break
      }

      case 'tool-result': {
        const existing = this.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'done'
          existing.output = p.output
          this.bus.emit({ type: 'task.item', taskId: this.taskId, item: existing })
        }
        break
      }

      case 'tool-error': {
        const existing = this.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'error'
          existing.error = p.error?.message ?? String(p.error)
          this.bus.emit({ type: 'task.item', taskId: this.taskId, item: existing })
        }
        break
      }

      case 'tool-output-denied': {
        const existing = this.toolMap.get(p.toolCallId)
        if (existing) {
          existing.state = 'denied'
          this.bus.emit({ type: 'task.item', taskId: this.taskId, item: existing })
        }
        break
      }
    }
  }

  /** Feeds one chunk of already-formed text into the live timeline.
   *
   *  The CLI provider path gets whole text blocks off a CLI's JSON stream rather than SDK
   *  `text-delta` parts, but it should still stream into the transcript the same way — otherwise a
   *  run whose first output takes the CLI's whole cold start (measured at 15–45s) shows nothing at
   *  all and reads as hung. Contained here so the cast stays in one place. */
  appendText(text: string): void {
    this.apply({ type: 'text-delta', text } as unknown as TextStreamPart<ToolSet>)
  }

  /** Flush any remaining text. */
  flush(): void {
    this.flushThinking()
    this.flushText()
  }

  private flushThinking(): void {
    if (this.thinkingId && this.thinkingText.trim()) this.emitThinking()
    this.thinkingId = null
    this.thinkingText = ''
  }

  private emitThinking(): void {
    if (!this.thinkingId || !this.thinkingText.trim()) return
    const item: TimelineItem = { kind: 'thinking', id: this.thinkingId, at: this.thinkingAt, text: this.thinkingText }
    const index = this.items.findIndex((i) => i.id === item.id)
    if (index >= 0) this.items[index] = item
    else this.items.push(item)
    this.bus.emit({ type: 'task.item', taskId: this.taskId, item })
  }

  private endCurrentText(): void {
    this.currentTextId = null
    this.currentText = ''
  }

  private flushText(): void {
    if (this.currentTextId && this.currentText.trim()) {
      this.emitCurrentTextItem()
    }
    this.endCurrentText()
  }

  private emitCurrentTextItem(): void {
    if (!this.currentTextId) return
    // Update or add the item
    const existing = this.items.find(
      (i) => i.kind === 'assistant' && i.id === this.currentTextId
    )
    if (existing && existing.kind === 'assistant') {
      existing.text = this.currentText
    } else {
      this.items.push({
        kind: 'assistant',
        id: this.currentTextId,
        at: this.now(),
        text: this.currentText
      })
    }
    const item = this.items.find(
      (i) => i.kind === 'assistant' && i.id === this.currentTextId
    )
    if (item) {
      this.bus.emit({ type: 'task.item', taskId: this.taskId, item })
    }
  }
}
