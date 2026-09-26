import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface ImportMcpConfigDialogProps {
  open: boolean
  onClose: () => void
}

/** Import MCP servers from an `mcp_config.json` file (the shape gemini CLIs — e.g. Antigravity —
 *  write). stdio and http servers are added; others (like sse) are skipped. */
export function ImportMcpConfigDialog({ open, onClose }: ImportMcpConfigDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const importConnectorConfig = useStore((s) => s.importConnectorConfig)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pathId = useId()
  const titleId = useId()

  const antigravityConfig = '~/.gemini/antigravity/mcp_config.json'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setPath('')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const importOne = async (): Promise<void> => {
    if (!path.trim()) {
      setError('Give the path to your mcp_config.json.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const list = await importConnectorConfig(path.trim())
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
      className="w-[480px] rounded-3xl border border-rule bg-card p-6 text-ink"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <h2 id={titleId} className="font-serif text-[24px] leading-tight">
        Import from mcp_config.json
      </h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        Point at an mcp_config.json (the one Antigravity and other gemini CLIs keep) and its stdio and
        http servers come in as connectors. Servers you already have by name are left alone.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={pathId}>
            Config file path
          </label>
          <input
            id={pathId}
            className="input"
            value={path}
            placeholder={antigravityConfig}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="button" className="btn btn-text mt-2" onClick={() => setPath(antigravityConfig)}>
            Use Antigravity&apos;s default file
          </button>
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