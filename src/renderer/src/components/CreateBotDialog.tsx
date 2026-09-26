import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface CreateBotDialogProps {
  open: boolean
  onClose: () => void
}

/** Creating a bot asks only for a name, then opens its page — everything else is edited there. */
export function CreateBotDialog({ open, onClose }: CreateBotDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const createBot = useStore((s) => s.createBot)
  const navigate = useStore((s) => s.navigate)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nameId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setName('')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the bot a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const bot = await createBot(trimmed)
      if (!bot) {
        setError("Couldn't create the bot. Try again.")
        return
      }
      onClose()
      navigate({ name: 'bot', botId: bot.id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="w-[420px] rounded-3xl border border-rule bg-card p-6 text-ink"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <h2 id={titleId} className="font-serif text-[24px] leading-tight">
        Name your bot
      </h2>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Bot name
          </label>
          <input
            id={nameId}
            autoFocus
            className="input"
            value={name}
            placeholder="Website watcher"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
        </div>
        {error && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-outline r-concentric"
            style={concentricVars(24)}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-ivory r-concentric"
            style={concentricVars(24)}
            disabled={busy}
            onClick={() => void create()}
          >
            Create bot
          </button>
        </div>
      </div>
    </dialog>
  )
}
