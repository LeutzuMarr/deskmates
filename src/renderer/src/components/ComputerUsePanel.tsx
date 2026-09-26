import { useEffect, useId, useRef, useState } from 'react'
import { core } from '../lib/rpc'
import { concentricVars } from '../lib/design'
import { useStore } from '../lib/store'
import { PROVIDERS, PROVIDER_LABELS, isCliProvider, isLocalProvider } from '../../../shared/protocol'
import type { ComputerSession, ModelCheck, ModelRef, ProviderId } from '../../../shared/protocol'
import { WorkingSpark } from './Working'
import { formatElapsed } from '../lib/format'

const CONSENT_KEY = 'deskmates.computerUse.consent'
const MODEL_KEY = 'deskmates.computerUse.model'

/** Model ids that can read screenshots and call tools, as far as their names tell. A hint for sorting
 *  the list, not a guarantee: anything the provider lists can still be picked. */
const SEES_SCREENSHOTS =
  /(gemini|gpt-4o|gpt-4\.1|gpt-5|o3|o4|kimi-k2\.[5-9]|kimi-k3|gemma-4|nemotron-3-nano-omni|qwen[\d.]*-?vl|qwen3\.[5-9]|pixtral|mistral-(medium|small|large-3)|grok-4|grok-2-vision|llava|minicpm-v|glm-4\.\dv|claude)/i

const CHECKS_KEY = 'deskmates.modelChecks'
const CHECK_TTL_MS = 24 * 60 * 60_000
const TEMPORARY_TTL_MS = 30 * 60_000
/** Providers that list models a key can't call (NVIDIA answers 404 "not found for account" for those). */
const CHECKED_PROVIDERS: ProviderId[] = ['nvidia']
const MAX_CHECKS = 10

type StoredCheck = ModelCheck & { at: number }

function readChecks(): Record<string, StoredCheck> {
  try {
    const all = JSON.parse(localStorage.getItem(CHECKS_KEY) ?? '{}') as Record<string, StoredCheck>
    return Object.fromEntries(
      Object.entries(all).filter(([, check]) => Date.now() - check.at < (check.temporary ? TEMPORARY_TTL_MS : CHECK_TTL_MS))
    )
  } catch {
    return {}
  }
}

function saveChecks(checks: Record<string, StoredCheck>): void {
  try {
    localStorage.setItem(CHECKS_KEY, JSON.stringify(checks))
  } catch {
    // Private storage: the models are checked again next time.
  }
}

function readModel(): ModelRef | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    const parsed = raw ? (JSON.parse(raw) as ModelRef) : null
    return parsed && PROVIDERS.includes(parsed.provider) && typeof parsed.modelId === 'string' ? parsed : null
  } catch {
    return null
  }
}

function saveModel(model: ModelRef): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(model))
  } catch {
    // Private storage: the default model is picked again next time.
  }
}

function readConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'yes'
  } catch {
    return false
  }
}

function saveConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, 'yes')
  } catch {
    // Private storage: the checkbox just shows again next time.
  }
}

const STATUS_LABELS: Record<ComputerSession['status'], string> = {
  running: 'Controlling your computer',
  done: 'Finished',
  stopped: 'Stopped',
  error: 'Stopped with a problem'
}

/** Agents tab → "Use my computer": a model sees the screen and drives the user's own mouse and keyboard. */
export function ComputerUsePanel() {
  const session = useStore((s) => s.computerSession)
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [prompt, setPrompt] = useState('')
  const [consent, setConsent] = useState(readConsent)
  const [busy, setBusy] = useState(false)
  const models = useStore((s) => s.models)
  const loadModels = useStore((s) => s.loadModels)
  const [pick, setPick] = useState<ModelRef | null>(readModel)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const promptId = useId()
  const providerId = useId()
  const modelSelectId = useId()
  const stepsRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    void core
      .call('computer.get', {})
      .then((current) => {
        if (current) useStore.setState({ computerSession: current })
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    stepsRef.current?.scrollTo({ top: stepsRef.current.scrollHeight })
  }, [session?.steps.length])

  const running = session?.status === 'running'

  // Until the user picks one, start from the default model when it can drive the screen at all.
  useEffect(() => {
    const fallback = settings?.defaultModel
    if (!pick && fallback && !isCliProvider(fallback.provider)) setPick(fallback)
  }, [settings?.defaultModel, pick])

  const provider = pick?.provider ?? null
  useEffect(() => {
    if (!provider || models[provider]) return
    setLoadingModels(true)
    setModelsError(null)
    loadModels(provider)
      .catch((error: unknown) => setModelsError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoadingModels(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const available = provider ? (models[provider] ?? []) : []
  const listed = pick?.modelId && !available.includes(pick.modelId) ? [pick.modelId, ...available] : available
  const [checks, setChecks] = useState<Record<string, StoredCheck | 'checking'>>(readChecks)
  const checkOf = (id: string): StoredCheck | 'checking' | undefined => (provider ? checks[`${provider}/${id}`] : undefined)
  const rank = (id: string): number => {
    const check = checkOf(id)
    return check === undefined || check === 'checking' ? 1 : check.usable ? 0 : 2
  }
  const likely = listed.filter((id) => SEES_SCREENSHOTS.test(id)).sort((a, b) => rank(a) - rank(b))
  const others = listed.filter((id) => !SEES_SCREENSHOTS.test(id))

  // Ask the provider, one tiny request per model, which of the likely models this key can really call.
  const toCheck = provider && CHECKED_PROVIDERS.includes(provider) ? [...new Set([...(pick?.modelId ? [pick.modelId] : []), ...likely])].slice(0, MAX_CHECKS) : []
  const checkKey = toCheck.join('|')
  useEffect(() => {
    if (!provider || toCheck.length === 0) return
    let cancelled = false
    const pending = toCheck.filter((id) => checks[`${provider}/${id}`] === undefined)
    const worker = async (): Promise<void> => {
      for (let id = pending.shift(); id && !cancelled; id = pending.shift()) {
        const key = `${provider}/${id}`
        setChecks((prev) => ({ ...prev, [key]: 'checking' }))
        const result = await core.call('models.check', { provider, modelId: id }).catch(
          (error: unknown): ModelCheck => ({ usable: true, detail: `Couldn't check: ${error instanceof Error ? error.message : String(error)}` })
        )
        setChecks((prev) => {
          const next = { ...prev, [key]: { ...result, at: Date.now() } }
          saveChecks(Object.fromEntries(Object.entries(next).filter((entry): entry is [string, StoredCheck] => entry[1] !== 'checking')))
          return next
        })
      }
    }
    void Promise.all([worker(), worker()])
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, checkKey])

  const label = (id: string): string => {
    const check = checkOf(id)
    if (check === 'checking') return `${id}  (checking…)`
    if (check && !check.usable) return `${id}  — ${check.temporary ? 'not answering right now' : 'not available for your key'}`
    if (check) return `✓ ${id}`
    return id
  }
  const pickedCheck = pick?.modelId ? checkOf(pick.modelId) : undefined

  const choose = (next: ModelRef): void => {
    setPick(next)
    if (next.modelId) saveModel(next)
  }

  const start = async (): Promise<void> => {
    if (!consent) return
    setBusy(true)
    try {
      saveConsent()
      const started = await core.call('computer.start', { prompt, model: pick })
      useStore.setState({ computerSession: started })
      setPrompt('')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await core.call('computer.stop', {})
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="rounded-3xl border border-rule bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-[20px] leading-tight">Use my computer</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            An agent looks at your screen and uses your mouse and keyboard to do a task. Deskmates minimizes itself
            while it works. Stop it any time with the Stop bar at the top of the screen or{' '}
            <span className="font-mono text-[12px]">Ctrl+Alt+Q</span>.
          </p>
        </div>
        {running && (
          <button type="button" className="btn btn-clay r-concentric shrink-0" style={concentricVars(20)} onClick={() => void stop()}>
            Stop
          </button>
        )}
      </div>

      {!running && (
        <div className="mt-4">
          <label htmlFor={promptId} className="sr-only">
            What should the agent do on your computer?
          </label>
          <textarea
            id={promptId}
            rows={3}
            value={prompt}
            placeholder="Open Spotify and play my Discover Weekly playlist…"
            onChange={(event) => setPrompt(event.target.value)}
            className="r-concentric w-full resize-none border border-rule bg-transparent px-3 py-2 text-[14px] leading-normal text-ink outline-none placeholder:text-ink-faint"
            style={concentricVars(20)}
          />
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
            <div className="field">
              <label className="field-label" htmlFor={providerId}>
                Provider
              </label>
              <select
                id={providerId}
                className="select"
                value={provider ?? ''}
                onChange={(event) => choose({ provider: event.target.value as ProviderId, modelId: '' })}
              >
                <option value="">Choose a provider</option>
                {PROVIDERS.filter((id) => !isCliProvider(id)).map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id]}
                    {isLocalProvider(id) ? ' (local)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={modelSelectId}>
                Model
              </label>
              <select
                id={modelSelectId}
                className="select"
                value={pick?.modelId ?? ''}
                disabled={!provider || loadingModels}
                onChange={(event) => provider && choose({ provider, modelId: event.target.value })}
              >
                <option value="">{loadingModels ? 'Loading models…' : 'Choose a model'}</option>
                {likely.length > 0 && (
                  <optgroup label="Can see screenshots">
                    {likely.map((id) => (
                      <option key={id} value={id}>
                        {label(id)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {others.length > 0 && (
                  <optgroup label={likely.length > 0 ? 'Other models (may not see images)' : 'Models'}>
                    {others.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          </div>
          <p
            className="mt-2 text-[12px] text-ink-faint"
            style={modelsError || (pickedCheck && pickedCheck !== 'checking' && !pickedCheck.usable) ? { color: 'var(--brick)' } : undefined}
          >
            {modelsError ??
              (pickedCheck === 'checking'
                ? 'Checking whether your key can use this model…'
                : pickedCheck && !pickedCheck.usable
                  ? `${pickedCheck.detail} Pick another model.`
                  : pickedCheck
                    ? `✓ ${pickedCheck.detail} It must also be able to see images and call tools.`
                    : 'The model must be able to see images and call tools. Models that look able to are listed first.')}
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              I understand the agent will control my mouse and keyboard until it finishes or I stop it.
            </label>
            <button
              type="button"
              className="btn btn-clay r-concentric shrink-0"
              style={concentricVars(20)}
              disabled={!consent || busy || prompt.trim() === '' || !pick?.modelId || (pickedCheck !== undefined && pickedCheck !== 'checking' && !pickedCheck.usable)}
              onClick={() => void start()}
            >
              Start
            </button>
          </div>
        </div>
      )}

      {session && (
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
          <div>
            {session.screenshot ? (
              <img
                src={session.screenshot}
                alt="What the agent sees"
                className="r-concentric w-full border border-rule"
                style={concentricVars(20)}
              />
            ) : (
              <div className="r-concentric aspect-video w-full border border-rule bg-oat" style={concentricVars(20)} />
            )}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 text-[13px]">
              {running ? (
                <WorkingSpark />
              ) : (
                <span className={`h-2 w-2 shrink-0 rounded-full ${session.status === 'done' ? 'bg-olive' : 'bg-ink-faint'}`} />
              )}
              <span className="font-medium">{STATUS_LABELS[session.status]}</span>
            </div>
            {running && session.waitingSince !== null && (
              <WaitingNote since={session.waitingSince} model={session.model} chars={session.thinkingChars} />
            )}
            <p className="mt-1 truncate text-[12px] text-ink-muted" title={session.prompt}>
              {session.prompt}
            </p>
            <ol ref={stepsRef} className="scroll-area mt-2 max-h-[220px] flex-1 overflow-y-auto text-[12px]">
              {session.steps.map((step, index) => (
                <li
                  key={`${step.at}-${index}`}
                  className={`py-0.5 ${step.kind === 'error' ? 'text-brick' : step.kind === 'action' ? 'font-mono text-ink-muted' : 'text-ink'}`}
                >
                  {step.text}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  )
}

/** Shown while the model is deciding its next move, so a slow model doesn't look frozen. */
function WaitingNote({ since, model, chars }: { since: number; model: string; chars: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])
  return (
    <p className="mt-1 text-[12px] text-ink-muted">
      {chars > 0 ? `${model} is thinking…` : `Waiting for ${model} to start…`}{' '}
      <span className="tabular-nums text-ink-faint">
        {formatElapsed(now - since)}
        {chars > 0 ? ` · ${chars.toLocaleString()} characters so far` : ''}
      </span>
    </p>
  )
}
