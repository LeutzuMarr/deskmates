import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Globe, Hand, RotateCw, X } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import type { SiteAnswer, SiteAsk } from '../../../shared/agent-browser'

const api = window.deskmates

/** The title bar's browser button: appears once an agent has used the browser, pulses while it acts. */
export function BrowserButton(): ReactNode {
  const browser = useStore((s) => s.browser)
  const open = useStore((s) => s.browserOpen)
  const setOpen = useStore((s) => s.setBrowserOpen)
  if (!browser || (!browser.used && browser.asks.length === 0)) return null
  const waiting = browser.asks.length > 0
  const label = waiting ? 'The agent browser needs you' : browser.busy ? `${browser.lastAgent ?? 'An agent'} is using the browser` : 'Agent browser'
  return (
    <button
      type="button"
      className="btn-icon no-drag relative"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={() => setOpen(!open)}
    >
      <Globe size={16} strokeWidth={1.75} aria-hidden="true" />
      {(browser.busy || waiting) && (
        <span
          aria-hidden="true"
          className={`absolute right-1 top-1 h-2 w-2 rounded-full ${waiting ? 'bg-clay' : 'bg-olive'} ${browser.busy && !waiting ? 'animate-pulse' : ''}`}
        />
      )}
    </button>
  )
}

function AskCard({ ask }: { ask: SiteAsk }): ReactNode {
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  const answer = async (value: SiteAnswer): Promise<void> => {
    setBusy(true)
    try {
      await core.call('browser.asks.respond', { id: ask.id, answer: value })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="msg-in rounded-2xl border border-rule bg-card p-3">
      <div className="text-[14px] leading-snug text-ink">
        {ask.kind === 'site' ? (
          <>
            <span className="font-semibold">{ask.agent}</span> wants to use <span className="font-semibold">{ask.domain}</span>.
          </>
        ) : (
          <>
            <span className="font-semibold">{ask.agent}</span> wants to {ask.detail}.
          </>
        )}
      </div>
      <div className="mt-1 text-[12px] text-ink-muted">
        {ask.kind === 'site' ? 'Reading pages is always allowed; this is for clicking and typing there.' : 'This sends or changes something in your name.'}
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-outline r-concentric" style={concentricVars(12)} disabled={busy} onClick={() => void answer('deny')}>
          Don't allow
        </button>
        {ask.kind === 'site' && (
          <button type="button" className="btn btn-outline r-concentric" style={concentricVars(12)} disabled={busy} onClick={() => void answer('always')}>
            Always allow
          </button>
        )}
        <button type="button" className="btn btn-ivory r-concentric" style={concentricVars(12)} disabled={busy} onClick={() => void answer('allow-once')}>
          {ask.kind === 'site' ? 'Allow this time' : 'Allow'}
        </button>
      </div>
    </div>
  )
}

/**
 * The floating browser panel, over the right of the window. Not drawn where a view docks the browser
 * itself (the Work tab's task view), so only one place ever holds the page.
 */
export function BrowserPanel({ docked = false }: { docked?: boolean }): ReactNode {
  const open = useStore((s) => s.browserOpen)
  const setOpen = useStore((s) => s.setBrowserOpen)

  // Escape closes the panel.
  useEffect(() => {
    if (!open || docked) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, docked, setOpen])

  if (!open || docked) return null
  return (
    <div className="fixed bottom-0 right-0 top-10 z-40 flex w-[58vw] min-w-[560px] max-w-full flex-col border-l border-rule bg-canvas shadow-2xl" role="dialog" aria-label="Agent browser">
      <BrowserSurface onClose={() => setOpen(false)} />
    </div>
  )
}

/** The Work tab's browser button: always there, so the browser can be opened before any agent uses it. */
export function DockBrowserButton(): ReactNode {
  const open = useStore((s) => s.browserOpen)
  const setOpen = useStore((s) => s.setBrowserOpen)
  const browser = useStore((s) => s.browser)
  const waiting = (browser?.asks.length ?? 0) > 0
  return (
    <button type="button" aria-pressed={open} className="btn btn-outline relative" onClick={() => setOpen(!open)} title={open ? 'Hide the browser' : "Show Deskmates' browser beside the chat"}>
      <Globe size={14} aria-hidden="true" className="mr-1.5" />
      Browser
      {(browser?.busy || waiting) && (
        <span aria-hidden="true" className={`absolute right-1 top-1 h-2 w-2 rounded-full ${waiting ? 'bg-clay' : 'bg-olive'} ${browser?.busy && !waiting ? 'animate-pulse' : ''}`} />
      )}
    </button>
  )
}

/**
 * The agent browser's live page, shown in the window by the app (a real page the user can click and
 * type in, for signing in). This draws the toolbar and reserves the area; the page itself is placed
 * over `pageRef` by the main process, for as long as this is mounted.
 */
export function BrowserSurface({ onClose }: { onClose: () => void }): ReactNode {
  const open = true
  const browser = useStore((s) => s.browser)
  const pageRef = useRef<HTMLDivElement>(null)
  const active = browser?.tabs.find((t) => t.active)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setAddress(active?.url ?? '')
  }, [active?.url, editing])

  // Tell the app where the page goes; null hides it again (and hands the browser back to the agent).
  const hasPage = Boolean(active) && api.browser !== undefined
  useLayoutEffect(() => {
    const element = pageRef.current
    if (!open || !hasPage || !element || !api.browser) {
      void api.browser?.setBounds(null)
      return
    }
    const send = (): void => {
      const r = element.getBoundingClientRect()
      void api.browser?.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    send()
    const observer = new ResizeObserver(send)
    observer.observe(element)
    window.addEventListener('resize', send)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      void api.browser?.setBounds(null)
    }
  }, [open, hasPage, browser?.asks.length])

  const userDriving = browser?.controller === 'user'

  const go = (event: FormEvent): void => {
    event.preventDefault()
    setEditing(false)
    if (address.trim()) void api.browser?.navigate('go', address.trim())
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-rule px-2 py-1.5">
        <button type="button" className="btn-icon" aria-label="Back" disabled={!api.browser} onClick={() => void api.browser?.navigate('back')}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="btn-icon" aria-label="Forward" disabled={!api.browser} onClick={() => void api.browser?.navigate('forward')}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="btn-icon" aria-label="Reload" disabled={!api.browser} onClick={() => void api.browser?.navigate('reload')}>
          <RotateCw size={14} />
        </button>
        <form className="mx-1 flex-1" onSubmit={go}>
          <input
            className="w-full rounded-lg border border-rule bg-card px-3 py-1 text-[13px] text-ink outline-none focus:border-ink-muted"
            value={address}
            aria-label="Address"
            spellCheck={false}
            disabled={!api.browser}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        <button type="button" className="btn-icon" aria-label="Close the browser panel" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {browser && browser.tabs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-rule px-2 py-1" role="tablist" aria-label="Tabs">
          {browser.tabs.map((tab) => (
            <div key={tab.tabId} className={`flex max-w-[220px] items-center gap-1 rounded-md px-2 py-0.5 text-[12px] ${tab.active ? 'bg-card text-ink' : 'text-ink-muted hover:bg-ink/5'}`}>
              <button type="button" role="tab" aria-selected={tab.active} className="truncate" title={tab.url} onClick={() => void api.browser?.selectTab(tab.tabId)}>
                {tab.title || tab.url}
              </button>
              <button type="button" aria-label="Close tab" className="text-ink-faint hover:text-ink" onClick={() => void api.browser?.closeTab(tab.tabId)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={`flex items-center gap-2 px-3 py-1.5 text-[12px] ${userDriving ? 'bg-clay/15 text-ink' : 'text-ink-muted'}`}>
        {userDriving ? (
          <>
            <Hand size={13} aria-hidden="true" />
            <span className="flex-1">You're using the browser. The agent waits until you hand it back.</span>
            <button type="button" className="btn btn-ivory r-concentric !py-0.5" style={concentricVars(10)} onClick={() => void api.browser?.handBack()}>
              Hand back to agent
            </button>
          </>
        ) : browser?.busy ? (
          <span>{browser.lastAgent ?? 'An agent'} is using the browser. Click or type in the page to take over (for example to sign in).</span>
        ) : (
          <span>Sign-ins you make here stay in this browser. Agents never see or type your passwords.</span>
        )}
      </div>
      {browser && browser.asks.length > 0 && (
        <div className="flex flex-col gap-2 px-3 pb-2">
          {browser.asks.map((ask) => (
            <AskCard key={ask.id} ask={ask} />
          ))}
        </div>
      )}
      <div ref={pageRef} className="relative min-h-0 flex-1 bg-white">
        {!hasPage && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-[13px] text-ink-muted">
            {api.browser ? 'No page is open yet. Type an address above, or ask an agent to open one.' : 'Open Deskmates on your PC to see and use the page.'}
          </div>
        )}
      </div>
    </>
  )
}
