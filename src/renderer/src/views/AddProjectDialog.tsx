import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface AddProjectDialogProps {
  open: boolean
  onClose: () => void
}

export function AddProjectDialog({ open, onClose }: AddProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const createProject = useStore((s) => s.createProject)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const folderId = useId()
  const nameId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setFolder('')
      setName('')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const browse = async (): Promise<void> => {
    const chosen = await window.deskmates.pickFolder()
    if (!chosen) return
    setFolder(chosen)
    const last = chosen.split(/[\\/]/).filter(Boolean).pop() ?? ''
    setName((current) => (current.trim() === '' ? last : current))
  }

  const add = async (): Promise<void> => {
    if (!folder.trim()) {
      setError('Choose a folder.')
      return
    }
    if (!name.trim()) {
      setError('Give the project a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createProject(name.trim(), folder)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
        Add a project
      </h2>
      <div className="mt-4 flex flex-col gap-4">
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
              placeholder="Choose a folder for Deskmates to work in"
            />
            <button type="button" className="btn btn-outline shrink-0" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Project name
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            placeholder="Project name"
            onChange={(event) => setName(event.target.value)}
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
            onClick={() => void add()}
          >
            Add project
          </button>
        </div>
      </div>
    </dialog>
  )
}