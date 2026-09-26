import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bot,
  Box,
  Check,
  CircleAlert,
  CircleDashed,
  Container,
  Download,
  Loader2,
  RotateCw,
  ShieldAlert,
  Sparkles,
  Terminal
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import type { BotTemplateInfo } from '../../../shared/protocol'
import { concentricVars } from '../lib/design'
import { ENGINE_STEP_LABELS } from '../lib/bots'
import type { EngineStatus, EngineStep, EngineStepState } from '../../../shared/protocol'

type WizardScreenId = EngineStep | 'first-bot'
type StepInfo = EngineStatus['steps'][EngineStep]

/** The first step whose engine status isn't `ok` yet, in order — except `image`, which never blocks
 *  progress (it downloads on its own the first time a bot's PC starts; see `ImageStep`). Everything
 *  here is derived straight from live `engineStatus`, never from separate wizard-only state, so
 *  closing and reopening the app lands on the same screen the real system state implies. */
function resolveScreen(status: EngineStatus, imageAcknowledged: boolean): WizardScreenId {
  if (status.steps.wsl.state !== 'ok') return 'wsl'
  if (status.steps.distro.state !== 'ok') return 'distro'
  if (status.steps.docker.state !== 'ok') return 'docker'
  if (status.steps.image.state !== 'ok' && !imageAcknowledged) return 'image'
  return 'first-bot'
}

const STEP_META: readonly { id: WizardScreenId; short: string; icon: LucideIcon }[] = [
  { id: 'wsl', short: 'WSL', icon: Terminal },
  { id: 'distro', short: 'Engine', icon: Box },
  { id: 'docker', short: 'Docker', icon: Container },
  { id: 'image', short: 'Image', icon: Download },
  { id: 'first-bot', short: 'First bot', icon: Bot }
]

const STATE_ICON: Record<EngineStepState, LucideIcon> = {
  ok: Check,
  missing: CircleDashed,
  'needs-admin': ShieldAlert,
  'needs-restart': RotateCw,
  working: Loader2,
  error: CircleAlert
}

const STATE_COLOR: Record<EngineStepState, string> = {
  ok: 'var(--olive)',
  missing: 'var(--ink-faint)',
  'needs-admin': 'var(--ink)',
  'needs-restart': 'var(--ink)',
  working: 'var(--ink-muted)',
  error: 'var(--brick)'
}

function StepIndicator({ current }: { current: WizardScreenId }) {
  const currentIndex = STEP_META.findIndex((s) => s.id === current)
  return (
    <ol className="flex items-center">
      {STEP_META.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming'
        return (
          <li key={step.id} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
              style={
                state === 'done'
                  ? { background: 'var(--olive)', color: '#fff' }
                  : state === 'current'
                    ? { border: '2px solid var(--ink)', color: 'var(--ink)' }
                    : { border: '1px solid var(--rule)', color: 'var(--ink-faint)' }
              }
            >
              {state === 'done' ? <Check size={12} aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={`whitespace-nowrap text-[12px] ${state === 'upcoming' ? 'text-ink-faint' : 'text-ink'} ${state === 'current' ? 'font-semibold' : ''}`}
            >
              {step.short}
            </span>
            {index < STEP_META.length - 1 && <span className="mx-1 h-px flex-1 bg-rule" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}

function StepShell({
  icon: Icon,
  stepLabel,
  heading,
  subheading,
  children
}: {
  icon: LucideIcon
  stepLabel: string
  heading: string
  subheading?: string
  children: ReactNode
}) {
  return (
    <div className="rounded-3xl border border-rule bg-card p-8">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-oat">
          <Icon size={18} aria-hidden="true" className="text-ink" />
        </span>
        <div>
          <div className="caption">{stepLabel}</div>
          <h2 className="font-serif text-[22px] leading-snug">{heading}</h2>
        </div>
      </div>
      {subheading && <p className="mt-2 text-[13px] text-ink-muted">{subheading}</p>}
      {children}
    </div>
  )
}

/** The live status line for an engine step, straight from `engineStatus.steps[x].detail` — never
 *  reworded, so this never claims a step succeeded (or explains a failure) beyond what the engine
 *  itself actually checked. */
function StatusRow({ info }: { info: StepInfo }) {
  const Icon = STATE_ICON[info.state]
  return (
    <div className="mt-5 flex items-start gap-3 border-t border-rule pt-5">
      <Icon
        size={16}
        aria-hidden="true"
        className={info.state === 'working' ? 'spin mt-0.5 shrink-0' : 'mt-0.5 shrink-0'}
        style={{ color: STATE_COLOR[info.state] }}
      />
      <p className={`text-[14px] ${info.state === 'working' ? 'pulse-txt text-ink-muted' : ''}`} style={info.state === 'error' ? { color: 'var(--brick)' } : undefined}>
        {info.detail}
      </p>
    </div>
  )
}

function WslStep({ status, busy, onContinue }: { status: EngineStatus; busy: boolean; onContinue: () => void }) {
  const info = status.steps.wsl
  const outcome = useStore((s) => s.wslInstallOutcome)
  const installing = useStore((s) => s.wslInstalling)
  const installWsl = useStore((s) => s.installWsl)

  const heading = (children: ReactNode): ReactNode => (
    <StepShell
      icon={Terminal}
      stepLabel="Step 1 of 5"
      heading={ENGINE_STEP_LABELS.wsl}
      subheading="Bot PCs run inside a small Linux environment called WSL — a one-time Windows setting, not something Deskmates installs on its own."
    >
      {children}
    </StepShell>
  )

  // A local outcome from the last administrator-prompt attempt takes over the whole screen: it's
  // more specific than whatever engineStatus.steps.wsl currently says (which, right after a restart
  // is needed, still just reads "needs an administrator prompt" — misleading here).
  if (outcome?.outcome === 'needs-restart') {
    return heading(
      <div className="mt-5 rounded-2xl border border-rule bg-oat p-4">
        <p className="text-[14px] font-medium text-ink">Restart this PC to finish this step</p>
        <p className="mt-1 text-[13px] text-ink-muted">
          Windows installed WSL, but it needs a restart before it's usable. Restart, then reopen Deskmates — setup
          picks up right here.
        </p>
      </div>
    )
  }

  if (outcome?.outcome === 'cancelled') {
    return heading(
      <>
        <div className="mt-5 rounded-2xl border border-rule bg-oat p-4">
          <p className="text-[14px] font-medium text-ink">You didn't approve the prompt</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            Nothing was changed. Bot PCs need WSL to run, so this step can't be skipped — try again when you're
            ready.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-clay r-concentric mt-5"
          style={concentricVars(24)}
          disabled={installing}
          onClick={() => void installWsl()}
        >
          {installing ? 'Waiting for Windows…' : 'Try again'}
        </button>
      </>
    )
  }

  if (outcome?.outcome === 'error') {
    return heading(
      <>
        <div className="error-bar mt-5" role="alert">
          {outcome.message}
        </div>
        <button
          type="button"
          className="btn btn-clay r-concentric mt-5"
          style={concentricVars(24)}
          disabled={installing}
          onClick={() => void installWsl()}
        >
          {installing ? 'Waiting for Windows…' : 'Try again'}
        </button>
      </>
    )
  }

  return heading(
    <>
      <StatusRow info={info} />
      {info.state === 'needs-admin' && (
        <>
          <p className="mt-4 text-[13px] text-ink-muted">
            Windows will ask for permission to turn WSL on. Approve the prompt to continue — this is the only
            command Deskmates ever runs as administrator, and only with your say-so each time.
          </p>
          <button
            type="button"
            className="btn btn-clay r-concentric mt-5"
            style={concentricVars(24)}
            disabled={installing}
            onClick={() => void installWsl()}
          >
            {installing ? 'Waiting for Windows…' : 'Give administrator access'}
          </button>
        </>
      )}
      {(info.state === 'missing' || info.state === 'error') && (
        <button type="button" className="btn btn-outline mt-5" disabled={busy} onClick={onContinue}>
          {busy ? 'Checking…' : "I've done this — check again"}
        </button>
      )}
    </>
  )
}

function DistroStep({ status, busy, onContinue }: { status: EngineStatus; busy: boolean; onContinue: () => void }) {
  const info = status.steps.distro
  const label = busy || info.state === 'working' ? 'Working…' : info.state === 'error' ? 'Try again' : 'Continue setup'
  return (
    <StepShell
      icon={Box}
      stepLabel="Step 2 of 5"
      heading={ENGINE_STEP_LABELS.distro}
      subheading="A small Linux system that runs your bots' PCs. It downloads once and lives on this computer from then on."
    >
      <StatusRow info={info} />
      {info.state === 'error' && (
        <p className="mt-3 text-[12px] italic text-ink-faint">
          This usually means not enough free disk space, or no internet connection. Free up space or check your
          connection, then try again.
        </p>
      )}
      {info.state !== 'ok' && (
        <button
          type="button"
          className="btn btn-clay r-concentric mt-5"
          style={concentricVars(24)}
          disabled={busy || info.state === 'working'}
          onClick={onContinue}
        >
          {label}
        </button>
      )}
    </StepShell>
  )
}

function DockerStep({ status, busy, onContinue }: { status: EngineStatus; busy: boolean; onContinue: () => void }) {
  const info = status.steps.docker
  const label = busy || info.state === 'working' ? 'Working…' : info.state === 'error' ? 'Try again' : 'Continue setup'
  return (
    <StepShell
      icon={Container}
      stepLabel="Step 3 of 5"
      heading={ENGINE_STEP_LABELS.docker}
      subheading="Each bot's PC runs as a lightweight container inside the Deskmates engine."
    >
      <StatusRow info={info} />
      {info.state === 'error' && (
        <p className="mt-3 text-[12px] italic text-ink-faint">
          This usually means no internet connection inside the Linux engine. Check your connection, then try again.
        </p>
      )}
      {info.state !== 'ok' && (
        <button
          type="button"
          className="btn btn-clay r-concentric mt-5"
          style={concentricVars(24)}
          disabled={busy || info.state === 'working'}
          onClick={onContinue}
        >
          {label}
        </button>
      )}
    </StepShell>
  )
}

function ImageStep({
  status,
  busy,
  onCheckAgain,
  onContinue
}: {
  status: EngineStatus
  busy: boolean
  onCheckAgain: () => void
  onContinue: () => void
}) {
  const info = status.steps.image
  return (
    <StepShell
      icon={Download}
      stepLabel="Step 4 of 5"
      heading={ENGINE_STEP_LABELS.image}
      subheading="What a bot's PC actually runs: a small Linux desktop with a browser, built for Deskmates."
    >
      <StatusRow info={info} />
      <p className="mt-3 text-[13px] text-ink-muted">
        {info.state === 'ok'
          ? "It's already downloaded — nothing to do here."
          : "This downloads on its own the first time a bot's PC starts. There's nothing to do here yet."}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onCheckAgain}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        <button type="button" className="btn btn-clay r-concentric" style={concentricVars(24)} onClick={onContinue}>
          Continue
        </button>
      </div>
    </StepShell>
  )
}

/**
 * The last wizard screen: pick a template, fill in what it asks for, and `bots.createFromTemplate`
 * makes the bot, its PC, its schedule and its starting memory in one call.
 */
function FirstBotStep() {
  const settings = useStore((s) => s.settings)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const [templates, setTemplates] = useState<BotTemplateInfo[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)

  const template = templates?.[0] ?? null
  const whatsappConfigured = Boolean(settings?.whatsappTo)

  useEffect(() => {
    let cancelled = false
    void core
      .call('bots.templates', {})
      .then((list) => {
        if (cancelled) return
        setTemplates(list)
        const first = list[0]
        if (first) {
          const initial: Record<string, string> = {}
          for (const field of first.fields) initial[field.key] = field.kind === 'time' ? first.suggestedTime : ''
          setValues(initial)
        }
      })
      .catch(() => {
        if (!cancelled) setTemplates([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const create = async (): Promise<void> => {
    if (!template) return
    setCreating(true)
    try {
      // The core emits bot.updated / pc.updated / schedule.updated, so the store picks the new bot up.
      const { bot, warnings } = await core.call('bots.createFromTemplate', { templateId: template.id, values })
      if (warnings.length > 0) showToast(warnings[0]!)
      navigate({ name: 'bot', botId: bot.id })
    } catch (error) {
      showToast(`Couldn't create the bot: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCreating(false)
    }
  }

  const missingRequired = template?.fields.some((field) => field.required && !values[field.key]?.trim()) ?? true

  return (
    <StepShell
      icon={Bot}
      stepLabel="Step 5 of 5"
      heading="Create your first bot"
      subheading="Bot PCs are ready. Start from the template below, or make one from scratch any time with New bot."
    >
      <div className="mt-5 rounded-3xl bg-manilla p-6">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
          <Sparkles size={14} aria-hidden="true" />
          Template
        </div>
        {template === null ? (
          <p className="mt-2 text-[13px] text-ink-muted">
            {templates === null ? 'Loading templates…' : 'No templates are available right now.'}
          </p>
        ) : (
          <>
            <h3 className="mt-1 font-serif text-[20px] leading-snug">{template.name}</h3>
            <p className="mt-2 text-[13px] text-ink-muted">{template.description}</p>

            <div className="mt-4 flex flex-col gap-3">
              {template.fields.map((field) => (
                <label key={field.key} className="field">
                  <span className="field-label">{field.label}</span>
                  <input
                    className="input"
                    type={field.kind === 'time' ? 'time' : 'text'}
                    value={values[field.key] ?? ''}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                  <span className="mt-1 text-[12px] text-ink-faint">{field.description}</span>
                </label>
              ))}
            </div>

            {!whatsappConfigured && (
              <p className="mt-3 text-[12px] text-ink-muted">
                Delivery needs your WhatsApp number, which isn't set yet.{' '}
                <button type="button" className="btn btn-text px-0 text-[12px]" onClick={() => navigate({ name: 'settings' })}>
                  Add it in Settings
                </button>
                .
              </p>
            )}

            <button
              type="button"
              className="btn btn-clay r-concentric mt-4"
              style={concentricVars(24)}
              disabled={creating || missingRequired}
              onClick={() => void create()}
            >
              {creating ? 'Creating…' : 'Create this bot'}
            </button>
          </>
        )}
      </div>
    </StepShell>
  )
}

/**
 * The Bots tab's setup wizard: WSL, the Deskmates engine, Docker, the bot PC image, then a first bot.
 * Which screen shows is entirely derived from live `engineStatus` (plus, for the non-blocking image
 * step, one local "seen it" flag) — never a separately tracked wizard step — so closing and
 * reopening the app resumes on whatever screen the real system state implies, not wherever the UI
 * last happened to be.
 */
export function SetupWizard({ onSkip }: { onSkip: () => void }) {
  const engineStatus = useStore((s) => s.engineStatus)
  const setupEngine = useStore((s) => s.setupEngine)
  const [busy, setBusy] = useState(false)
  const [imageAcknowledged, setImageAcknowledged] = useState(false)

  const runSetup = async (): Promise<void> => {
    setBusy(true)
    try {
      await setupEngine()
    } finally {
      setBusy(false)
    }
  }

  if (!engineStatus) {
    return (
      <div className="rounded-3xl border border-rule bg-card p-8">
        <p className="text-[14px] text-ink-muted">Checking bot PC setup…</p>
      </div>
    )
  }

  const screen = resolveScreen(engineStatus, imageAcknowledged)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-serif text-[20px] leading-snug">Setting up bot PCs</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          This finishes the pieces one at a time and can take a while — it may need your permission or a restart.
          Close Deskmates any time; reopening it picks up right where this left off.
        </p>
        <div className="mt-4">
          <StepIndicator current={screen} />
        </div>
      </div>

      {screen === 'wsl' && <WslStep status={engineStatus} busy={busy} onContinue={() => void runSetup()} />}
      {screen === 'distro' && <DistroStep status={engineStatus} busy={busy} onContinue={() => void runSetup()} />}
      {screen === 'docker' && <DockerStep status={engineStatus} busy={busy} onContinue={() => void runSetup()} />}
      {screen === 'image' && (
        <ImageStep
          status={engineStatus}
          busy={busy}
          onCheckAgain={() => void runSetup()}
          onContinue={() => setImageAcknowledged(true)}
        />
      )}
      {screen === 'first-bot' && <FirstBotStep />}

      <button type="button" className="btn btn-text self-start px-0 text-[13px]" onClick={onSkip}>
        Skip for now — I'll finish this later
      </button>
    </div>
  )
}
