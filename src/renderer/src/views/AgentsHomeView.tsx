import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { BrandMark } from '../components/Mascot'
import { TerminalStatusMark } from '../components/TerminalStatusMark'
import { StartTerminalSessionDialog } from '../components/StartTerminalSessionDialog'
import { ComputerUsePanel } from '../components/ComputerUsePanel'
import { TOOL_LABELS, attachStateLabel, onboardingLabel, sessionStateLabel, sinceLabel } from '../lib/terminals'

const DETECT_POLL_MS = 4000

export function AgentsHomeView() {
  const detected = useStore((s) => s.detectedAgents)
  const sessions = useStore((s) => s.terminalSessions)
  const attached = useStore((s) => s.attachedTerminalSessions)
  const refreshDetectedAgents = useStore((s) => s.refreshDetectedAgents)
  const attachTerminal = useStore((s) => s.attachTerminal)
  const navigate = useStore((s) => s.navigate)
  const [startOpen, setStartOpen] = useState(false)

  // Refreshed every few seconds only while this screen is mounted, per the job's brief — detection
  // is a plain process listing with no event source of its own to push updates from.
  useEffect(() => {
    void refreshDetectedAgents()
    const timer = setInterval(() => void refreshDetectedAgents(), DETECT_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshDetectedAgents])

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-10">
        <h1 className="font-serif text-[44px] leading-[1.1]">Agents</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          Talk to the coding agents you already use. Deskmates can find OpenCode and Antigravity (agy) sessions
          running on this computer, attach to a terminal you already have open, or start its own managed sessions.
        </p>

        <div className="mt-12">
          <ComputerUsePanel />
        </div>

        <div className="mt-12 flex items-center justify-between">
          <h2 className="caption">Running on this computer</h2>
        </div>
        {detected.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-5 text-[13px] text-ink-faint">
            No OpenCode or Antigravity processes found right now.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {detected.map((process) => {
              const open = attached.find((item) => item.pid === process.pid && item.state !== 'closed')
              return (
                <div key={`${process.tool}-${process.pid}`} className="rounded-3xl border border-rule bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-serif text-[16px]">{TOOL_LABELS[process.tool]}</span>
                    <span className="text-[12px] text-ink-faint">pid {process.pid} · since {sinceLabel(process.startedAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-[12px] text-ink-faint" title={process.folder ?? undefined}>
                    {process.folder ?? "folder not shown on this process's command line"}
                  </div>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    {open ? (
                      <button type="button" className="btn btn-ivory" onClick={() => navigate({ name: 'agents-attach', sessionId: open.id })}>
                        Open terminal
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-clay"
                        onClick={() => void attachTerminal(process.tool, process.pid)}
                      >
                        Attach
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-2 text-[12px] text-ink-faint">
          Attach types straight into the terminal window — best with Windows Terminal or a classic console window.
          It can't attach to Git Bash (mintty) or an elevated (admin) terminal. Your terminal keeps working normally
          while Deskmates is attached.
        </p>

        <div className="mt-8 flex items-center justify-between">
          <h2 className="caption">Attached terminals</h2>
        </div>
        {attached.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-5 text-[13px] text-ink-faint">
            Nothing attached yet. Pick an agent above to attach to its terminal.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {attached.map((item) => (
              <button
                type="button"
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-3xl border border-rule bg-card p-4 text-left hover:bg-oat"
                onClick={() => navigate({ name: 'agents-attach', sessionId: item.id })}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <TerminalStatusMark state={item.state} />
                  <span className="truncate font-serif text-[16px]">{TOOL_LABELS[item.tool]}</span>
                </div>
                <span className="shrink-0 text-[12px] text-ink-faint">
                  pid {item.pid} · {attachStateLabel(item.state)}
                  {onboardingLabel(item.onboarding) ? ` · ${onboardingLabel(item.onboarding)}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <h2 className="caption">Managed sessions</h2>
          {sessions.length > 0 && (
            <button type="button" className="btn btn-outline" onClick={() => setStartOpen(true)}>
              New session
            </button>
          )}
        </div>

        {sessions.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-10 text-center">
            <div className="flex justify-center">
              <BrandMark size={40} />
            </div>
            <h3 className="mt-4 font-serif text-[20px] leading-snug">Start your first managed session</h3>
            <p className="mx-auto mt-2 max-w-[360px] text-[14px] text-ink-muted">
              Pick OpenCode or Antigravity and a folder, and Deskmates runs the tool itself and streams its replies
              here — no terminal needed.
            </p>
            <button
              type="button"
              className="r-concentric btn btn-ivory mt-6"
              style={concentricVars(24)}
              onClick={() => setStartOpen(true)}
            >
              Start a managed session
            </button>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className="rounded-3xl border border-rule bg-card p-5 text-left hover:bg-oat"
                onClick={() => navigate({ name: 'agents-session', sessionId: session.id })}
              >
                <div className="flex items-center gap-2">
                  <TerminalStatusMark state={session.state} />
                  <span className="truncate font-serif text-[17px]">{TOOL_LABELS[session.tool]}</span>
                </div>
                <div className="mt-1 truncate text-[12px] text-ink-faint" title={session.folder}>
                  {session.folder}
                </div>
                <div className="mt-1 text-[12px] text-ink-faint">
                  {sessionStateLabel(session.state)}
                  {onboardingLabel(session.onboarding) ? ` · ${onboardingLabel(session.onboarding)}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <StartTerminalSessionDialog open={startOpen} onClose={() => setStartOpen(false)} />
    </main>
  )
}