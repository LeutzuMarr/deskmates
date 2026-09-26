import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface InstallPluginDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Install a plugin — either a folder on this computer (like a bundled file you downloaded) or a
 * GitHub repo (owner/repo or a github.com/SH/co link). Skills bundled inside it get imported too.
 */
export function InstallPluginDialog({ open, onClose }: InstallPluginDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const installPlugin = useStore((s) => s.installPlugin)
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sourceId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setSource('')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const install = async (): Promise<void> => {
    if (!source.trim()) {
      setError('Give a folder path or an owner/repo GitHub link.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const list = await installPlugin(source.trim())
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
        Install a plugin
      </h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        A plugin bundles skills (and later connectors) into one folder you keep in one place. Point at a
        folder already on this computer, or clone a GitHub repo.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={sourceId}>
            Folder or GitHub repo
          </label>
          <input
            id={sourceId}
            className="input"
            value={source}
            placeholder={'C:\\path\\to\\plugin folder, or owner/repo'}
            onChange={(event) => setSource(event.target.value)}
          />
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
            onClick={() => void install()}
          >
            Install
          </button>
        </div>
      </div>
    </dialog>
  )
}