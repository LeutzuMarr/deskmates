import { useState } from 'react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { toolLabel } from '../lib/format'
import { concentricVars } from '../lib/design'
import type { ToolItem } from '../../../shared/protocol'

interface ApprovalCardProps {
  /** Whether `id` names a Work-tab task (calls `approvals.respond`) or a bot run (calls `runs.respond`) — these are different RPC methods over different id spaces, never interchangeable. */
  mode: 'task' | 'run'
  id: string
  item: ToolItem
}

export function ApprovalCard({ mode, id, item }: ApprovalCardProps) {
  const showToast = useStore((s) => s.showToast)
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)

  const input = (item.input ?? {}) as Record<string, unknown>
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value))
  const cwd = item.toolName === 'run_command' ? str(input.cwd ?? '.') : null
  const statement =
    item.toolName === 'delete_path'
      ? `Delete ${str(input.path)}`
      : item.toolName === 'delete_file'
        ? `Delete ${Array.isArray(input.paths) ? input.paths.map(str).join(', ') : str(input.paths)}`
        : item.toolName === 'run_command' || item.toolName === 'Bash'
          ? `Run: ${str(input.command)}`
          : item.toolName === 'run_script'
            ? `Run a script${input.purpose ? ` to ${str(input.purpose)}` : ''}:\n${str(input.code).slice(0, 600)}`
            : item.toolName === 'Workflow'
              ? `Run a workflow of sub-agents:\n${str(input.script).slice(0, 600)}`
              : item.toolName === 'add_mcp_server'
                ? input.config_path
                  ? `Install the MCP servers listed in ${str(input.config_path)}`
                  : `Install the MCP server "${str(input.name)}": ${input.url ? str(input.url) : [input.command, ...(Array.isArray(input.args) ? input.args : [])].map(str).join(' ')}`
                : item.toolName === 'install_skill'
                  ? `Install skills from ${str(input.path)}`
                  : item.toolName === 'install_plugin'
                    ? `Install the plugin ${str(input.source)}`
                    : toolLabel(item.toolName, item.input)

  const respond = async (approved: boolean): Promise<void> => {
    if (busy || !item.approvalId) return
    setBusy(true)
    try {
      const approvalId = item.approvalId
      if (mode === 'run') {
        await core.call('runs.respond', { runId: id, approvalId, approved, always: approved ? always : undefined })
      } else {
        await core.call('approvals.respond', { taskId: id, approvalId, approved, always: approved ? always : undefined })
      }
    } catch (error) {
      showToast(`Couldn't send your answer: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="msg-in rounded-3xl border border-rule bg-card p-4">
      <div className="font-serif text-[18px] leading-snug">Allow this action?</div>
      <div className="mt-2 font-mono text-[13px] leading-relaxed">
        <div className="whitespace-pre-wrap break-words">{statement}</div>
        {cwd !== null && <div className="text-ink-muted">in {cwd}</div>}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" className="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <span>Always allow this for this {mode === 'run' ? 'bot' : 'task'}</span>
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-outline r-concentric"
          style={concentricVars(16)}
          disabled={busy}
          onClick={() => void respond(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-ivory r-concentric"
          style={concentricVars(16)}
          disabled={busy}
          onClick={() => void respond(true)}
        >
          Approve
        </button>
      </div>
    </div>
  )
}