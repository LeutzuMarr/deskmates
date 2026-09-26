import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface ImportSkillDialogProps {
  open: boolean
  onClose: () => void
}

/** Import a skill: a folder holding a SKILL.md (open Agent Skills format). The folder is copied
 *  into the skills library, so later edits to the source folder don't change the installed skill. */
export function ImportSkillDialog({ open, onClose }: ImportSkillDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const importSkill = useStore((s) => s.importSkill)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const folderId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setFolder('')
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
    setError(null)
  }

  const importOne = async (): Promise<void> => {
    if (!folder.trim()) {
      setError('Choose a skill folder, or a folder of skills.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const list = await importSkill(folder.trim())
      if (list) onClose()
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
      className="w-[440px] rounded-3xl border border-rule bg-card p-6 text-ink"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <h2 id={titleId} className="font-serif text-[24px] leading-tight">
        Import a skill
      </h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        A skill is a folder with a SKILL.md in it (the open Agent Skills format) plus whatever files it
        needs. Importing copies it into the library and lets the assistant load it on demand. Pick a
        folder of skills (like <span className="font-mono text-[12px]">C:\Users\you\.claude\skills</span>)
        to import all of them at once.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={folderId}>
            Skill folder
          </label>
          <div className="flex gap-2">
            <input
              id={folderId}
              className="input flex-1"
              value={folder}
              readOnly
              placeholder="A skill folder, or a folder of skills"
            />
            <button type="button" className="btn btn-outline shrink-0" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
        </div>
        {error && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="btn btn-outline r-concentric" style={concentricVars(24)} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-ivory r-concentric"
            style={concentricVars(24)}
            disabled={busy}
            onClick={() => void importOne()}
          >
            Import
          </button>
        </div>
      </div>
    </dialog>
  )
}