import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { TOOL_LABELS } from '../lib/terminals'
import type { TerminalTool } from '../../../shared/protocol'

interface StartTerminalSessionDialogProps {
  open: boolean
  onClose: () => void
}

const TOOLS: TerminalTool[] = ['opencode', 'agy']

export function StartTerminalSessionDialog({ open, onClose }: StartTerminalSessionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const startTerminalSession = useStore((s) => s.startTerminalSession)
  const [tool, setTool] = useState<TerminalTool>('opencode')
  const [folder, setFolder] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const folderId = useId()
  const modelId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setTool('opencode')
      setFolder('')
      setModel('')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const browse = async (): Promise<void> => {
    const chosen = await window.deskmates.pickFolder()
    if (chosen) setFolder(chosen)
  }

  const start = async (): Promise<void> => {
    if (!folder.trim()) {
      setError('Choose a folder to run in.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const session = await startTerminalSession(tool, folder, model.trim() || undefined)
      if (!session) return // startTerminalSession already toasted the failure
      onClose()
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
        Start a managed session
      </h2>
      <p className="mt-1 text-[13px] text-ink-muted">
        Deskmates runs the tool's own non-interactive command in the folder you pick, and checks that it knows about
        Deskmates before your first prompt.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div role="tablist" aria-label="Tool" className="segmented">
          {TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tool === t}
              className="segmented-item"
              onClick={() => setTool(t)}
            >
              {TOOL_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={folderId}>
            Folder
          </label>
          <div className="flex gap-2">
            <input
              id={folderId}
              className="input flex-1"
              value={folder}
              readOnly
              placeholder="Choose the folder the agent should work in"
            />
            <button type="button" className="btn btn-outline shrink-0" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={modelId}>
            Model (optional)
          </label>
          <input
            id={modelId}
            className="input"
            value={model}
            placeholder={tool === 'opencode' ? 'opencode/big-pickle' : "the CLI's default model"}
            onChange={(event) => setModel(event.target.value)}
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
            onClick={() => void start()}
          >
            Start session
          </button>
        </div>
      </div>
    </dialog>
  )
}
