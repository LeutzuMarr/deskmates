import { useEffect, useId, useRef, useState } from 'react'
import { CirclePlay, Hand, Monitor, RotateCcw, SquareStop } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { IDLE_STOP_MAX, IDLE_STOP_MIN, MEMORY_MB_MAX, MEMORY_MB_MIN } from '../lib/bots'
import { PcStatusLine } from './PcStatusMark'
import { PcModeSwitch } from './PcModeSwitch'
import type { Bot, BotPc } from '../../../shared/protocol'

type Endpoints = { novnc: string; agent: string; cdp: string }
type PcAction = 'start' | 'stop' | 'reset' | null

interface BotPcPanelProps {
  bot: Bot
  pc: BotPc | undefined
  engineReady: boolean
  onGoToSetup: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BotPcPanel({ bot, pc, engineReady, onGoToSetup }: BotPcPanelProps) {
  const showToast = useStore((s) => s.showToast)
  const [endpoints, setEndpoints] = useState<Endpoints | null>(null)
  const [takenOver, setTakenOver] = useState(false)
  const [takeOverBusy, setTakeOverBusy] = useState(false)
  const [action, setAction] = useState<PcAction>(null)
  const [idleStop, setIdleStop] = useState(String(pc?.idleStopMinutes ?? 30))
  const [memoryMb, setMemoryMb] = useState(String(pc?.memoryMb ?? 1024))
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Mirrors `takenOver` so effects below can read the latest value without re-running on every change.
  const takenOverRef = useRef(false)

  const idleId = useId()
  const memoryId = useId()

  const state = pc?.state ?? 'absent'

  useEffect(() => {
    takenOverRef.current = takenOver
  }, [takenOver])

  // A fresh bot page, or leaving this panel while still taken over: release the pause server-side
  // too (pcs.takeOver), not just the local toggle — otherwise the bot stays genuinely paused for a
  // bot whose "Take over" the user can no longer even see, until Deskmates is restarted.
  useEffect(() => {
    return () => {
      if (takenOverRef.current) void core.call('pcs.takeOver', { botId: bot.id, on: false }).catch(() => {})
    }
  }, [bot.id])
  useEffect(() => setTakenOver(false), [bot.id])
  useEffect(() => {
    if (state === 'running') return
    if (takenOverRef.current) void core.call('pcs.takeOver', { botId: bot.id, on: false }).catch(() => {})
    setTakenOver(false)
  }, [state, bot.id])

  useEffect(() => {
    setIdleStop(String(pc?.idleStopMinutes ?? 30))
    setMemoryMb(String(pc?.memoryMb ?? 1024))
  }, [bot.id, pc?.idleStopMinutes, pc?.memoryMb])

  useEffect(() => {
    let cancelled = false
    if (state !== 'running') {
      setEndpoints(null)
      return
    }
    void core.call('pcs.endpoints', { botId: bot.id }).then(
      (result) => {
        if (!cancelled) setEndpoints(result)
      },
      () => {
        if (!cancelled) setEndpoints(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [bot.id, state])

  const toggleTakenOver = async (): Promise<void> => {
    if (takeOverBusy) return
    const next = !takenOver
    setTakeOverBusy(true)
    try {
      // Awaited before flipping the UI: entering take-over should only claim "you're in control"
      // once the runner has actually confirmed the pause, since that's what makes it true.
      await core.call('pcs.takeOver', { botId: bot.id, on: next })
      setTakenOver(next)
      if (!next) iframeRef.current?.blur()
    } catch (error) {
      showToast(`Couldn't ${next ? 'take over' : 'give back control of'} ${bot.name}'s PC: ${errorMessage(error)}`)
    } finally {
      setTakeOverBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    setAction('start')
    try {
      await core.call('pcs.start', { botId: bot.id })
    } catch (error) {
      showToast(`Couldn't start ${bot.name}'s PC: ${errorMessage(error)}`)
    } finally {
      setAction(null)
    }
  }

  const stop = async (): Promise<void> => {
    setAction('stop')
    try {
      await core.call('pcs.stop', { botId: bot.id })
    } catch (error) {
      showToast(`Couldn't stop ${bot.name}'s PC: ${errorMessage(error)}`)
    } finally {
      setAction(null)
    }
  }

  const reset = async (): Promise<void> => {
    const confirmed = window.confirm(
      `Reset "${bot.name}"'s PC to a clean state? It will lose its logins and files on that PC. This can't be undone.`
    )
    if (!confirmed) return
    setAction('reset')
    try {
      await core.call('pcs.reset', { botId: bot.id })
    } catch (error) {
      showToast(`Couldn't reset ${bot.name}'s PC: ${errorMessage(error)}`)
    } finally {
      setAction(null)
    }
  }

  const saveIdleStop = async (): Promise<void> => {
    const n = Number(idleStop)
    const fallback = pc?.idleStopMinutes ?? 30
    if (!Number.isInteger(n) || n < IDLE_STOP_MIN || n > IDLE_STOP_MAX) {
      showToast(`Idle stop time must be a whole number of minutes between ${IDLE_STOP_MIN} and ${IDLE_STOP_MAX}.`)
      setIdleStop(String(fallback))
      return
    }
    if (n === fallback) return
    try {
      await core.call('pcs.update', { botId: bot.id, idleStopMinutes: n })
    } catch (error) {
      showToast(`Couldn't save: ${errorMessage(error)}`)
      setIdleStop(String(fallback))
    }
  }

  const saveMemory = async (): Promise<void> => {
    const n = Number(memoryMb)
    const fallback = pc?.memoryMb ?? 1024
    if (!Number.isInteger(n) || n < MEMORY_MB_MIN || n > MEMORY_MB_MAX) {
      showToast(`Memory must be a whole number of megabytes between ${MEMORY_MB_MIN} and ${MEMORY_MB_MAX}.`)
      setMemoryMb(String(fallback))
      return
    }
    if (n === fallback) return
    try {
      await core.call('pcs.update', { botId: bot.id, memoryMb: n })
    } catch (error) {
      showToast(`Couldn't save: ${errorMessage(error)}`)
      setMemoryMb(String(fallback))
    }
  }

  const liveHint =
    state === 'starting'
      ? 'Starting…'
      : state === 'running'
        ? "Connecting to the bot's screen…"
        : state === 'error'
          ? (pc?.error ?? "This PC hit an error.")
          : `${bot.name}'s PC isn't running. Start it to see its screen.`

  return (
    <div className="flex flex-col gap-8">
      {!engineReady && (
        <p className="text-[13px] text-ink-muted">
          Bot PCs aren't set up on this computer yet.{' '}
          <button type="button" className="btn btn-text px-0 text-[13px]" onClick={onGoToSetup}>
            Finish setup
          </button>{' '}
          to start this PC.
        </p>
      )}

      <section>
        <h2 className="caption">Live view</h2>
        <div className="relative mt-3 overflow-hidden rounded-3xl border border-rule bg-card" style={{ aspectRatio: '16 / 10' }}>
          {endpoints ? (
            <iframe
              ref={iframeRef}
              title={`${bot.name} live view`}
              src={endpoints.novnc}
              tabIndex={takenOver ? 0 : -1}
              className="absolute inset-0 h-full w-full border-0"
              style={{ pointerEvents: takenOver ? 'auto' : 'none' }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Monitor size={28} aria-hidden="true" className="text-ink-faint" />
              <p className="max-w-[320px] text-[13px] text-ink-muted">{liveHint}</p>
            </div>
          )}
          {endpoints && (
            <div
              className="pill pointer-events-none absolute left-3 top-3"
              aria-live="polite"
              style={takenOver ? { color: 'var(--ink)', fontWeight: 600 } : undefined}
            >
              {takenOver ? "You're in control" : `${bot.name} is in control`}
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={takenOver}
            aria-label={takenOver ? 'Give control back to the bot' : 'Take over the mouse and keyboard'}
            className="btn btn-outline"
            disabled={!endpoints || takeOverBusy}
            onClick={() => void toggleTakenOver()}
          >
            <Hand size={14} aria-hidden="true" className="mr-1.5" />
            {takeOverBusy ? (takenOver ? 'Giving back…' : 'Taking over…') : takenOver ? 'Give control back' : 'Take over'}
          </button>
          {endpoints && (
            <span className="text-[12px] text-ink-faint">
              {takenOver
                ? "You have the mouse and keyboard — the bot won't click anything until you give control back."
                : "Clicks and keys don't reach the bot's screen until you take over."}
            </span>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="caption">PC controls</h2>
          <PcStatusLine state={state} />
        </div>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-outline"
              disabled={action !== null || state === 'running' || state === 'starting'}
              onClick={() => void start()}
            >
              <CirclePlay size={14} aria-hidden="true" className="mr-1.5" />
              {action === 'start' ? 'Starting…' : 'Start PC'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={action !== null || (state !== 'running' && state !== 'starting')}
              onClick={() => void stop()}
            >
              <SquareStop size={14} aria-hidden="true" className="mr-1.5" />
              {action === 'stop' ? 'Stopping…' : 'Stop PC'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={action !== null || state === 'absent'}
              onClick={() => void reset()}
            >
              <RotateCcw size={14} aria-hidden="true" className="mr-1.5" />
              {action === 'reset' ? 'Resetting…' : 'Reset PC'}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-rule pt-4">
            <div className="field">
              <label className="field-label" htmlFor={idleId}>
                Stop after idle (minutes, 0 = keep running)
              </label>
              <input
                id={idleId}
                type="number"
                min={IDLE_STOP_MIN}
                max={IDLE_STOP_MAX}
                className="input"
                value={idleStop}
                onChange={(event) => setIdleStop(event.target.value)}
                onBlur={() => void saveIdleStop()}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={memoryId}>
                Memory cap (MB)
              </label>
              <input
                id={memoryId}
                type="number"
                min={MEMORY_MB_MIN}
                max={MEMORY_MB_MAX}
                step={128}
                className="input"
                value={memoryMb}
                onChange={(event) => setMemoryMb(event.target.value)}
                onBlur={() => void saveMemory()}
              />
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="caption">Bot PC mode (applies to every bot)</h2>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          <PcModeSwitch />
        </div>
      </section>
    </div>
  )
}
