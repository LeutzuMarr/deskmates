import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { BUILT_IN_COMMANDS, OPEN_SHORTCUTS_EVENT } from '../lib/commands'

const MOD = typeof window !== 'undefined' && window.deskmates?.platform === 'darwin' ? '⌘' : 'Ctrl'

const SHORTCUTS: Array<[string, string]> = [
  ['Enter', 'Send the message'],
  ['Shift+Enter', 'New line'],
  ['Esc', 'Stop the agent'],
  ['Tab', 'Use the suggested next message'],
  ['↑ / ↓', 'Earlier messages you sent'],
  ['/', 'Commands and skills'],
  ['@', 'A file in the project'],
  [`${MOD}+V`, 'Paste a screenshot to attach it'],
  [`${MOD}+K`, 'Search and commands'],
  [`${MOD}+N`, 'New chat'],
  [`${MOD}+B`, 'Show or hide the sidebar'],
  [`${MOD}+,`, 'Settings'],
  [`${MOD}+1 … 5`, 'Work, Design, Bots, Agents, Extras'],
  [`${MOD}+/`, 'This list']
]

/** Every keyboard shortcut and message-box command, opened with Ctrl+/ or /help, as in Claude. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const show = (): void => setOpen(true)
    const onKey = (event: KeyboardEvent): void => {
      const mod = window.deskmates?.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (mod && event.key === '/') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener(OPEN_SHORTCUTS_EVENT, show)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, show)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="w-[520px] max-w-[calc(100vw-32px)] rounded-3xl border border-rule bg-card p-6 text-ink"
      onClose={() => setOpen(false)}
      onClick={(event) => {
        if (event.target === ref.current) setOpen(false)
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id={titleId} className="font-serif text-[22px] leading-tight">
          Keyboard shortcuts
        </h2>
        <button type="button" className="copy-btn h-8 w-8 justify-center p-0" aria-label="Close" onClick={() => setOpen(false)}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt>
              <kbd className="kbd">{keys}</kbd>
            </dt>
            <dd className="text-ink-muted">{what}</dd>
          </div>
        ))}
      </dl>
      <h3 className="caption mt-6">Commands in the message box</h3>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
        {BUILT_IN_COMMANDS.map((command) => (
          <div key={command.name} className="contents">
            <dt className="font-mono">{command.name}</dt>
            <dd className="text-ink-muted">{command.description}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  )
}
