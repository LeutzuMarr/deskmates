/**
 * The message box's own commands, as Claude has them: typed as a whole message (/clear, /model,
 * /help, /export), they act in the app and never reach the agent. They are listed first in the "/"
 * menu, before installed skills.
 */
import { useStore } from './store'
import { chatMarkdown } from './chat-markdown'
import { startNewTask } from './shortcuts'

export interface BuiltInCommand {
  name: string
  description: string
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  { name: '/clear', description: 'Start a new chat' },
  { name: '/model', description: 'Choose the model' },
  { name: '/export', description: 'Save this chat as a Markdown file' },
  { name: '/help', description: 'Keyboard shortcuts and commands' }
]

/** Opens the model menu under the message box. */
export const OPEN_MODEL_PICKER_EVENT = 'deskmates:open-model-picker'
/** Opens the keyboard shortcuts panel. */
export const OPEN_SHORTCUTS_EVENT = 'deskmates:open-shortcuts'

export { chatMarkdown }

/** Saves the chat as a .md file (the browser's save prompt picks where). */
export function exportChat(taskId: string): void {
  const state = useStore.getState()
  const task = Object.values(state.tasksByProject)
    .flat()
    .find((t) => t.id === taskId)
  const timeline = state.timelines[taskId] ?? []
  if (!task || timeline.length === 0) {
    state.showToast('There is nothing to export in this chat yet.')
    return
  }
  const blob = new Blob([chatMarkdown(task.title, timeline)], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${(task.title.trim() || 'chat').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Runs a built-in command typed in the message box. */
export function runBuiltIn(name: string, where: { taskId?: string; projectId: string }): void {
  const state = useStore.getState()
  if (name === '/clear') {
    if (state.tab === 'design') state.navigate({ name: 'design-home' })
    else startNewTask()
  } else if (name === '/model') {
    window.dispatchEvent(new Event(OPEN_MODEL_PICKER_EVENT))
  } else if (name === '/help') {
    window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))
  } else if (name === '/export') {
    if (where.taskId) exportChat(where.taskId)
    else state.showToast('Send a message first: there is no chat to export yet.')
  }
}
