import { useEffect, useId, useRef, useState } from 'react'
import type { Connector, ConnectorTransport } from '../../../shared/protocol'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface ConnectorDialogProps {
  open: boolean
  onClose: () => void
  /** The connector being edited; undefined means create a new one. */
  connector?: Connector
}

/** Parses `KEY=VALUE` lines from the environment textarea. Invalid lines are skipped. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
    if (match) env[match[1]!] = match[2]!
  }
  return env
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/** Add or edit an MCP connector (spec 5.6). */
export function ConnectorDialog({ open, onClose, connector }: ConnectorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const createConnector = useStore((s) => s.createConnector)
  const updateConnector = useStore((s) => s.updateConnector)

  const [name, setName] = useState('')
  const [transport, setTransport] = useState<ConnectorTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nameId = useId()
  const transportId = useId()
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setName(connector ? connector.name : '')
      setTransport(connector ? connector.transport : 'stdio')
      setCommand(connector?.command ?? '')
      setArgs(connector?.args.join(' ') ?? '')
      setUrl(connector?.url ?? '')
      setEnv(connector ? formatEnv(connector.env) : '')
      setError(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, connector])

  const save = async (): Promise<void> => {
    const base: {
      name: string
      transport: ConnectorTransport
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
    } = { name: name.trim(), transport }
    if (transport === 'stdio') {
      base.command = command.trim()
      base.args = args.trim() ? args.trim().split(/\s+/) : []
      base.env = parseEnv(env)
    } else {
      base.url = url.trim()
    }
    if (!base.name) {
      setError('The connector needs a name.')
      return
    }
    if (transport === 'stdio' && !base.command) {
      setError('A stdio connector needs a command to run.')
      return
    }
    if (transport === 'http' && !base.url) {
      setError('An HTTP connector needs a URL.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const list = connector ? await updateConnector(connector.id, base) : await createConnector(base)
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
        {connector ? 'Edit connector' : 'Add a connector'}
      </h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        A connector is an MCP server the assistant and your bots can call tools on. Over stdio it spawns a
        command on this computer; over HTTP it reaches a streamable server.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            placeholder="e.g. filesystem"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={transportId}>
            Transport
          </label>
          <select
            id={transportId}
            className="input"
            value={transport}
            onChange={(event) => setTransport(event.target.value as ConnectorTransport)}
          >
            <option value="stdio">stdio — run a command</option>
            <option value="http">HTTP — streamable server URL</option>
          </select>
        </div>
        {transport === 'stdio' ? (
          <>
            <div className="field">
              <label className="field-label" htmlFor={`${nameId}-command`}>
                Command
              </label>
              <input
                id={`${nameId}-command`}
                className="input"
                value={command}
                placeholder={'npx @modelcontextprotocol/server-filesystem'}
                onChange={(event) => setCommand(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${nameId}-args`}>
                Arguments (space-separated)
              </label>
              <input
                id={`${nameId}-args`}
                className="input"
                value={args}
                placeholder={'C:\\Projects\\Docs'}
                onChange={(event) => setArgs(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${nameId}-env`}>
                Environment variables (one KEY=VALUE per line)
              </label>
              <textarea
                id={`${nameId}-env`}
                className="input min-h-[70px] resize-y"
                value={env}
                placeholder={'API_KEY=abc123'}
                onChange={(event) => setEnv(event.target.value)}
              />
            </div>
          </>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor={`${nameId}-url`}>
              Server URL
            </label>
            <input
              id={`${nameId}-url`}
              className="input"
              value={url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        )}
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
            onClick={() => void save()}
          >
            {connector ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </dialog>
  )
}