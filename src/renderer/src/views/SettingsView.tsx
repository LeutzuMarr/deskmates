import { useEffect, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useStore } from '../lib/store'
import { core } from '../lib/rpc'
import { concentricVars } from '../lib/design'
import { isValidWhatsAppNumber } from '../lib/bots'
import { DEFAULT_SETTINGS, PROVIDERS, PROVIDER_LABELS, isCliProvider, isLocalProvider } from '../../../shared/protocol'
import type { Appearance, PcCloudConnection, PcHostKind, PhoneInfo, ProviderId } from '../../../shared/protocol'

type LocalUrlField = 'ollamaBaseUrl' | 'lmstudioBaseUrl'
const LOCAL_URL_FIELD: Partial<Record<ProviderId, LocalUrlField>> = { ollama: 'ollamaBaseUrl', lmstudio: 'lmstudioBaseUrl' }

type LocalServerStatus = { state: 'checking' } | { state: 'running'; count: number } | { state: 'error'; message: string }

const EMPTY_PC_CONNECTION: PcCloudConnection = {
  endpoint: '',
  tlsCertPath: '',
  tlsKeyPath: '',
  tlsCaPath: '',
  registryUsername: '',
  registryPassword: ''
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const keyStatus = useStore((s) => s.keyStatus)
  const models = useStore((s) => s.models)
  const usage = useStore((s) => s.usage)
  const loadModels = useStore((s) => s.loadModels)
  const setKeyStatus = useStore((s) => s.setKeyStatus)
  const showToast = useStore((s) => s.showToast)

  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({})
  const [keySaving, setKeySaving] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [keyErrors, setKeyErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const [compatibleUrl, setCompatibleUrl] = useState('')
  const [localUrls, setLocalUrls] = useState<Record<LocalUrlField, string>>({ ollamaBaseUrl: '', lmstudioBaseUrl: '' })
  const [localStatus, setLocalStatus] = useState<Partial<Record<ProviderId, LocalServerStatus>>>({})
  const [modelProvider, setModelProvider] = useState<ProviderId | ''>('')
  const [modelId, setModelId] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [whatsappTo, setWhatsappTo] = useState('')
  const [whatsappError, setWhatsappError] = useState<string | null>(null)
  const [phoneInfo, setPhoneInfo] = useState<PhoneInfo | null>(null)
  const [pcHost, setPcHost] = useState<PcHostKind>('local')
  const [pcConnection, setPcConnection] = useState<PcCloudConnection>(EMPTY_PC_CONNECTION)
  const pcSeeded = useRef(false)

  useEffect(() => {
    if (settings) {
      setCompatibleUrl(settings.compatibleBaseUrl)
      setLocalUrls({ ollamaBaseUrl: settings.ollamaBaseUrl, lmstudioBaseUrl: settings.lmstudioBaseUrl })
      setInstructions(settings.globalInstructions)
      setWhatsappTo(settings.whatsappTo)
      setWhatsappError(null)
      if (!pcSeeded.current) {
        pcSeeded.current = true
        setPcHost(settings.pcHost)
        setPcConnection(settings.pcConnection ?? EMPTY_PC_CONNECTION)
      }
      const defaultModel = settings.defaultModel
      if (defaultModel) {
        setModelProvider(defaultModel.provider)
        setModelId(defaultModel.modelId)
        if (!models[defaultModel.provider]) {
          void loadModels(defaultModel.provider).catch(() => undefined)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  useEffect(() => {
    void window.deskmates
      .autoStart.get()
      .then(setAutoStart)
      .catch(() => undefined)
  }, [])

  // Phone access state (listening? on which port?) follows the toggle and the code: the listener
  // starts asynchronously, and the URLs only appear once it's really up.
  useEffect(() => {
    if (!settings?.phoneAccess) {
      setPhoneInfo(null)
      return
    }
    let cancelled = false
    void core
      .call('phone.info', {})
      .then((info) => {
        if (!cancelled) setPhoneInfo(info)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.phoneAccess, settings?.pairingCode])

  const saveKey = async (provider: ProviderId): Promise<void> => {
    const value = (keys[provider] ?? '').trim()
    if (!value || keySaving[provider]) return
    setKeySaving((prev) => ({ ...prev, [provider]: true }))
    setKeyErrors((prev) => ({ ...prev, [provider]: undefined }))
    try {
      const updated = await window.deskmates.secrets.set(provider, value)
      forgetModelChecks()
      setKeyStatus(updated)
      setKeys((prev) => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setKeyErrors((prev) => ({
        ...prev,
        [provider]: error instanceof Error ? error.message : String(error)
      }))
    } finally {
      setKeySaving((prev) => ({ ...prev, [provider]: false }))
    }
  }

  const removeKey = async (provider: ProviderId): Promise<void> => {
    try {
      const updated = await window.deskmates.secrets.set(provider, null)
      forgetModelChecks()
      setKeyStatus(updated)
    } catch (error) {
      showToast(`Couldn't remove the key: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveCompatibleUrl = async (): Promise<void> => {
    if (!settings || compatibleUrl === settings.compatibleBaseUrl) return
    try {
      await core.call('settings.update', { compatibleBaseUrl: compatibleUrl })
    } catch (error) {
      showToast(`Couldn't save the server URL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveLocalUrl = async (field: LocalUrlField): Promise<void> => {
    if (!settings || localUrls[field] === settings[field]) return
    try {
      await core.call('settings.update', { [field]: localUrls[field].trim() })
    } catch (error) {
      showToast(`Couldn't save the server URL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const checkLocalServer = async (provider: ProviderId, field: LocalUrlField): Promise<void> => {
    setLocalStatus((prev) => ({ ...prev, [provider]: { state: 'checking' } }))
    await saveLocalUrl(field)
    try {
      const list = await loadModels(provider)
      setLocalStatus((prev) => ({ ...prev, [provider]: { state: 'running', count: list.length } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLocalStatus((prev) => ({ ...prev, [provider]: { state: 'error', message } }))
    }
  }

  const localServerFields = (provider: ProviderId): ReactNode => {
    const field = LOCAL_URL_FIELD[provider]
    if (!field) return null
    const label = PROVIDER_LABELS[provider]
    const status = localStatus[provider]
    return (
      <>
        <p className="mt-2 text-[12px] text-ink-muted">
          {provider === 'lmstudio'
            ? 'No API key needed — uses the models downloaded in LM Studio on this PC. Turn on its local server (Developer tab) first.'
            : `No API key needed — uses the models installed in ${label} on this PC.`}
        </p>
        <div className="mt-2">
          <label className="sr-only" htmlFor={`url-${provider}`}>
            {label} server URL
          </label>
          <input
            id={`url-${provider}`}
            className="input"
            value={localUrls[field]}
            placeholder={DEFAULT_SETTINGS[field]}
            onChange={(event) => setLocalUrls((prev) => ({ ...prev, [field]: event.target.value }))}
            onBlur={() => void saveLocalUrl(field)}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-outline"
            disabled={status?.state === 'checking'}
            onClick={() => void checkLocalServer(provider, field)}
          >
            {status?.state === 'checking' ? 'Checking…' : 'Find models'}
          </button>
          {status?.state === 'running' && (
            <span className="text-[12px] text-ink-muted">
              Running · {status.count} {status.count === 1 ? 'model' : 'models'} installed
            </span>
          )}
          {status?.state === 'error' && <span className="text-[12px] text-brick">{status.message}</span>}
        </div>
      </>
    )
  }

  const loadModelsFor = async (provider: ProviderId): Promise<void> => {
    setLoadingModels(true)
    try {
      const list = await loadModels(provider)
      let pick = list[0] ?? ''
      if (provider === 'google') pick = list.find((m) => m.toLowerCase().includes('flash')) ?? pick
      if (provider === 'openai') pick = list.find((m) => m.toLowerCase().includes('mini')) ?? pick
      setModelId(pick)
    } catch (error) {
      showToast(`Couldn't load models: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingModels(false)
    }
  }

  const saveDefaultModel = async (): Promise<void> => {
    if (!modelProvider || !modelId) return
    try {
      await core.call('settings.update', { defaultModel: { provider: modelProvider, modelId } })
      showToast('Default model saved')
    } catch (error) {
      showToast(`Couldn't save the default model: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveInstructions = async (): Promise<void> => {
    try {
      await core.call('settings.update', { globalInstructions: instructions })
    } catch (error) {
      showToast(`Couldn't save the instructions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveWhatsapp = async (): Promise<void> => {
    const trimmed = whatsappTo.trim()
    if (!settings || trimmed === settings.whatsappTo) return
    if (!isValidWhatsAppNumber(trimmed)) {
      setWhatsappError('Enter it in international format, starting with + and the country code, like +14155552671.')
      return
    }
    setWhatsappError(null)
    try {
      // Never logged: this only ever reaches settings.update, and errors from it never echo params back.
      await core.call('settings.update', { whatsappTo: trimmed })
    } catch (error) {
      showToast(`Couldn't save the WhatsApp number: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const toggleAutoStart = async (checked: boolean): Promise<void> => {
    try {
      await window.deskmates.autoStart.set(checked)
      setAutoStart(checked)
    } catch (error) {
      showToast(`Couldn't change start-at-login: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const togglePhoneAccess = async (checked: boolean): Promise<void> => {
    try {
      await core.call('settings.update', { phoneAccess: checked })
    } catch (error) {
      showToast(`Couldn't change phone access: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const regeneratePairingCode = async (): Promise<void> => {
    try {
      // An empty code read as "give me a fresh one" by settings.update.
      await core.call('settings.update', { pairingCode: '' })
    } catch (error) {
      showToast(`Couldn't regenerate the code: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const savePcHost = async (next: PcHostKind): Promise<void> => {
    setPcHost(next)
    try {
      await core.call('settings.update', { pcHost: next, pcConnection })
    } catch (error) {
      showToast(`Couldn't change the bot PC host: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const savePcField = async (field: keyof PcCloudConnection, value: string): Promise<void> => {
    const next = { ...pcConnection, [field]: value }
    setPcConnection(next)
    try {
      await core.call('settings.update', { pcHost, pcConnection: next })
    } catch (error) {
      showToast(`Couldn't save the bot PC connection: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-8">
        <h1 className="font-serif text-[24px] leading-tight">Settings</h1>

        <section className="mt-8">
          <h2 className="caption">AI providers</h2>
          <div className="mt-3 flex flex-col gap-3">
            {PROVIDERS.map((provider) => (
              <div key={provider} className="rounded-3xl border border-rule bg-card p-4">
                <div className="font-medium text-[14px]">{PROVIDER_LABELS[provider]}</div>
                {isCliProvider(provider) ? (
                  <p className="mt-2 text-[12px] text-ink-muted">
                    No API key needed — {PROVIDER_LABELS[provider]} is installed on this PC and runs through
                    its own command line.
                  </p>
                ) : isLocalProvider(provider) ? (
                  localServerFields(provider)
                ) : (
                  <>
                    <div className="mt-2 flex items-center gap-2">
                      <label className="sr-only" htmlFor={`key-${provider}`}>
                        {PROVIDER_LABELS[provider]} API key
                      </label>
                      <input
                        id={`key-${provider}`}
                        type="password"
                        autoComplete="off"
                        className="input flex-1"
                        value={keys[provider] ?? ''}
                        placeholder={
                          keyStatus.includes(provider) ? '••••••••••••••••  saved — paste a new key to replace it' : 'Paste your API key'
                        }
                        onChange={(event) => setKeys((prev) => ({ ...prev, [provider]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveKey(provider)
                        }}
                        onBlur={() => void saveKey(provider)}
                      />
                    </div>
                    {provider === 'compatible' && (
                      <div className="mt-2">
                        <label className="sr-only" htmlFor="compatible-url">
                          Server URL
                        </label>
                        <input
                          id="compatible-url"
                          className="input"
                          value={compatibleUrl}
                          placeholder="https://…/v1"
                          onChange={(event) => setCompatibleUrl(event.target.value)}
                          onBlur={() => void saveCompatibleUrl()}
                        />
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        className="btn btn-outline"
                        disabled={keySaving[provider] || !(keys[provider] ?? '').trim()}
                        onClick={() => void saveKey(provider)}
                      >
                        {keySaving[provider] ? 'Saving…' : keyStatus.includes(provider) ? 'Replace key' : 'Save key'}
                      </button>
                      {keyStatus.includes(provider) ? (
                        <>
                          <span className="flex items-center gap-1 text-[12px] font-medium" style={{ color: 'var(--olive)' }}>
                            <Check size={13} aria-hidden="true" />
                            Saved on this computer
                          </span>
                          <button type="button" className="btn btn-text px-0 text-[13px]" onClick={() => void removeKey(provider)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <span className="text-[12px] text-ink-faint">Not set</span>
                      )}
                      {keyErrors[provider] && <span className="text-[12px] text-brick">{keyErrors[provider]}</span>}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">Default model</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="field">
                <label className="field-label" htmlFor="model-provider">
                  Provider
                </label>
                <select
                  id="model-provider"
                  className="select"
                  value={modelProvider}
                  onChange={(event) => {
                    setModelProvider(event.target.value as ProviderId | '')
                    setModelId('')
                  }}
                >
                  <option value="">Choose a provider</option>
                  {PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                      {provider === 'opencode' || provider === 'agy' ? ' (CLI)' : ''}
                      {isLocalProvider(provider) ? ' (local)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="model-id">
                  Model
                </label>
                <select
                  id="model-id"
                  className="select"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                >
                  <option value="">Choose a model</option>
                  {(models[modelProvider as ProviderId] ?? []).map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="btn btn-outline"
                disabled={!modelProvider || loadingModels}
                onClick={() => modelProvider && void loadModelsFor(modelProvider)}
              >
                {loadingModels ? 'Loading…' : 'Load models'}
              </button>
              <button
                type="button"
                className="btn btn-ivory"
                disabled={!modelProvider || !modelId}
                onClick={() => void saveDefaultModel()}
              >
                Save default model
              </button>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">Instructions for every project</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <label className="sr-only" htmlFor="global-instructions">
              Instructions for every project
            </label>
            <textarea
              id="global-instructions"
              className="input min-h-[96px] w-full resize-y"
              value={instructions}
              placeholder="These rules apply to every project, on top of each project's own instructions."
              onChange={(event) => setInstructions(event.target.value)}
            />
            <div className="mt-2 flex justify-end">
              <button type="button" className="btn btn-outline" onClick={() => void saveInstructions()}>
                Save instructions
              </button>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">WhatsApp</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <label className="field-label" htmlFor="whatsapp-to">
              Your WhatsApp number
            </label>
            <input
              id="whatsapp-to"
              className="input mt-1.5"
              value={whatsappTo}
              placeholder="+14155552671"
              autoComplete="off"
              onChange={(event) => {
                setWhatsappTo(event.target.value)
                if (whatsappError) setWhatsappError(null)
              }}
              onBlur={() => void saveWhatsapp()}
            />
            {whatsappError && (
              <div className="error-bar mt-2" role="alert">
                {whatsappError}
              </div>
            )}
            <p className="mt-2 text-[12px] text-ink-faint">
              Bots message this number from a dedicated WhatsApp number of their own — never your personal one. The
              bot's phone signs in once, by scanning a QR code through Take over on its PC.
            </p>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">Phone access</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <label className="flex items-center gap-2 text-[14px] text-ink">
              <input
                type="checkbox"
                className="checkbox"
                checked={!!settings?.phoneAccess}
                onChange={(event) => void togglePhoneAccess(event.target.checked)}
              />
              <span>Allow another device on this network</span>
            </label>
            {settings?.phoneAccess && settings.pairingCode && (
              <div className="mt-3">
                <p className="field-label">Pairing code</p>
                <p className="mt-1 font-mono text-[24px] tracking-[0.35em] text-ink" aria-label="Pairing code">
                  {settings.pairingCode}
                </p>
                {phoneInfo?.error && (
                  <div className="error-bar mt-2" role="alert">
                    {phoneInfo.error}
                  </div>
                )}
                {!phoneInfo?.error && (
                  <>
                    <p className="mt-3 text-[12px] text-ink-faint">
                      On the phone, open a browser on the same network and go to:
                    </p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {phoneInfo?.urls.map((url) => (
                        <li key={url} className="font-mono text-[13px] text-ink">
                          {url}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[12px] text-ink-faint">
                      The phone signs in with this code and can use the app while your computer is on the same
                      network. Turn this off or regenerate the code to close the door.
                    </p>
                    <button type="button" className="btn btn-text px-0 text-[13px]" onClick={() => void regeneratePairingCode()}>
                      Regenerate code
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">Bot PC host</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <p className="text-[12px] text-ink-faint">
              Run each bot's PC in the engine on this computer, or on a Docker server on your network.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[14px] text-ink">
                <input
                  type="radio"
                  name="pc-host"
                  className="checkbox"
                  checked={pcHost === 'local'}
                  onChange={() => void savePcHost('local')}
                />
                <span>Local engine (this computer)</span>
              </label>
              <label className="flex items-center gap-2 text-[14px] text-ink">
                <input
                  type="radio"
                  name="pc-host"
                  className="checkbox"
                  checked={pcHost === 'cloud'}
                  onChange={() => void savePcHost('cloud')}
                />
                <span>Docker server on the network</span>
              </label>
            </div>
            {pcHost === 'cloud' && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <input
                    className="input"
                    aria-label="Docker server endpoint"
                    value={pcConnection.endpoint}
                    placeholder="tcp://192.168.1.20:2375"
                    onChange={(event) => void savePcField('endpoint', event.target.value)}
                  />
                  <p className="text-[12px] text-ink-faint">The Docker Engine URL. tcp://, http:// or https://.</p>
                </div>
                <details className="flex flex-col gap-2">
                  <summary className="cursor-pointer text-[13px] text-ink-muted">Advanced</summary>
                  <input
                    className="input"
                    aria-label="TLS client certificate path"
                    value={pcConnection.tlsCertPath}
                    placeholder="C:\certs\cert.pem"
                    onChange={(event) => void savePcField('tlsCertPath', event.target.value)}
                  />
                  <input
                    className="input"
                    aria-label="TLS client key path"
                    value={pcConnection.tlsKeyPath}
                    placeholder="C:\certs\key.pem"
                    onChange={(event) => void savePcField('tlsKeyPath', event.target.value)}
                  />
                  <input
                    className="input"
                    aria-label="TLS CA path"
                    value={pcConnection.tlsCaPath}
                    placeholder="C:\certs\ca.pem"
                    onChange={(event) => void savePcField('tlsCaPath', event.target.value)}
                  />
                  <input
                    className="input"
                    aria-label="Registry username"
                    value={pcConnection.registryUsername}
                    placeholder="Registry user / password for a private image"
                    onChange={(event) => void savePcField('registryUsername', event.target.value)}
                  />
                  <input
                    className="input"
                    aria-label="Registry password"
                    value={pcConnection.registryPassword}
                    placeholder="Registry user / password for a private image"
                    onChange={(event) => void savePcField('registryPassword', event.target.value)}
                  />
                </details>
              </div>
            )}
          </div>
        </section>

        <AppearanceSection />

        <section className="mt-8">
          <h2 className="caption">Usage</h2>
          <div className="mt-3">
            <UsageTable />
            <p className="mt-2 text-[12px] text-ink-faint">
              Requests and tokens per day. Google's free tier has daily limits.
            </p>
          </div>
        </section>

        <CodingAgentsSection />
      </div>
    </main>
  )
}

function UsageTable() {
  const usage = useStore((s) => s.usage)
  if (usage.length === 0) {
    return <p className="text-[13px] text-ink-faint">No usage yet.</p>
  }
  return (
    <div className="overflow-x-auto rounded-3xl border border-rule">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[12px] text-ink-faint">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Day
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Provider
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Requests
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              In
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Out
            </th>
          </tr>
        </thead>
        <tbody>
          {usage.map((row) => (
            <tr key={`${row.day}-${row.provider}`} className="border-t border-rule">
              <td className="px-4 py-2 font-mono text-[12px]">{row.day}</td>
              <td className="px-4 py-2">{PROVIDER_LABELS[row.provider]}</td>
              <td className="px-4 py-2 text-right">{row.requests}</td>
              <td className="px-4 py-2 text-right">{formatTokens(row.inputTokens)}</td>
              <td className="px-4 py-2 text-right">{formatTokens(row.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function AppearanceSection() {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const appearance = settings?.appearance
  const ready = appearance !== undefined

  const save = async (patch: Partial<Appearance>): Promise<void> => {
    if (!appearance) return
    try {
      await core.call('settings.update', { appearance: { ...appearance, ...patch } })
    } catch (error) {
      showToast(`Couldn't save the appearance: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const chooseLogo = async (): Promise<void> => {
    try {
      const url = await window.deskmates.appearance.pickImage()
      if (url !== null) await save({ logo: url })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  const chooseFont = async (field: 'uiFont' | 'replyFont'): Promise<void> => {
    try {
      const font = await window.deskmates.appearance.pickFont()
      if (font !== null) await save({ [field]: font })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  const chooseAnimation = async (field: 'idleAnimation' | 'workingAnimation'): Promise<void> => {
    try {
      const animation = await window.deskmates.appearance.pickAnimation()
      if (animation !== null) await save({ [field]: animation })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="mt-8">
      <h2 className="caption">Appearance</h2>
      <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
        <AppearanceRow
          label="Logo"
          value={appearance?.logo ? 'Custom image' : 'Mate'}
          preview={
            appearance?.logo ? <img src={appearance.logo} alt="" className="h-8 w-8 shrink-0 object-contain" /> : undefined
          }
          primary={{ label: 'Choose image…', disabled: !ready, onClick: () => void chooseLogo() }}
          secondary={{ label: 'Use Mate', disabled: !ready || !appearance?.logo, onClick: () => void save({ logo: null }) }}
        />
        <AppearanceRow
          label="Idle animation"
          value={appearance?.idleAnimation?.name ?? 'Mate'}
          primary={{ label: 'Choose animation…', disabled: !ready, onClick: () => void chooseAnimation('idleAnimation') }}
          secondary={{
            label: 'Use Mate',
            disabled: !ready || !appearance?.idleAnimation,
            onClick: () => void save({ idleAnimation: null })
          }}
        />
        <AppearanceRow
          label="Working animation"
          value={appearance?.workingAnimation?.name ?? 'Mate'}
          primary={{ label: 'Choose animation…', disabled: !ready, onClick: () => void chooseAnimation('workingAnimation') }}
          secondary={{
            label: 'Use Mate',
            disabled: !ready || !appearance?.workingAnimation,
            onClick: () => void save({ workingAnimation: null })
          }}
        />
        <AppearanceRow
          label="Interface font"
          value={appearance?.uiFont?.name ?? 'Default'}
          primary={{ label: 'Choose font file…', disabled: !ready, onClick: () => void chooseFont('uiFont') }}
          secondary={{ label: 'Use default', disabled: !ready || !appearance?.uiFont, onClick: () => void save({ uiFont: null }) }}
        />
        <AppearanceRow
          label="Reply font"
          value={appearance?.replyFont?.name ?? 'Default'}
          primary={{ label: 'Choose font file…', disabled: !ready, onClick: () => void chooseFont('replyFont') }}
          secondary={{
            label: 'Use default',
            disabled: !ready || !appearance?.replyFont,
            onClick: () => void save({ replyFont: null })
          }}
        />
      </div>
    </section>
  )
}

function AppearanceRow({
  label,
  value,
  preview,
  primary,
  secondary
}: {
  label: string
  value: string
  preview?: ReactNode
  primary: { label: string; disabled: boolean; onClick: () => void }
  secondary: { label: string; disabled: boolean; onClick: () => void }
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        {preview}
        <div className="min-w-0">
          <div className="text-[14px] font-medium">{label}</div>
          <div className="truncate text-[12px] text-ink-muted" title={value}>
            {value}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="btn btn-outline" disabled={primary.disabled} onClick={primary.onClick}>
          {primary.label}
        </button>
        <button type="button" className="btn btn-text" disabled={secondary.disabled} onClick={secondary.onClick}>
          {secondary.label}
        </button>
      </div>
    </div>
  )
}

type AgentToolId = 'opencode' | 'cline' | 'antigravity'

interface AgentToolConfig {
  label: string
  /** Where the snippet below goes, exactly as shown to the user. */
  location: string
  snippet: (commandPath: string) => string
}

/** JSON-escapes backslashes so a Windows path is valid inside a JSON string value. */
function jsonEscapePath(path: string): string {
  return path.replace(/\\/g, '\\\\')
}

function openCodeSnippet(commandPath: string): string {
  const cmd = jsonEscapePath(commandPath)
  return `{
  "mcp": {
    "deskmates": {
      "type": "local",
      "command": ["${cmd}", "mcp"],
      "enabled": true
    }
  }
}`
}

/** Cline and Antigravity both read the same mcpServers shape. */
function mcpServersSnippet(commandPath: string): string {
  const cmd = jsonEscapePath(commandPath)
  return `{
  "mcpServers": {
    "deskmates": {
      "command": "${cmd}",
      "args": ["mcp"]
    }
  }
}`
}

const AGENT_TOOL_ORDER: AgentToolId[] = ['opencode', 'cline', 'antigravity']

const AGENT_TOOLS: Record<AgentToolId, AgentToolConfig> = {
  opencode: {
    label: 'OpenCode',
    location: 'opencode.json in the project, or %USERPROFILE%\\.config\\opencode\\opencode.json',
    snippet: openCodeSnippet
  },
  cline: {
    label: 'Cline',
    location: 'Cline → MCP Servers → Configure, cline_mcp_settings.json',
    snippet: mcpServersSnippet
  },
  antigravity: {
    label: 'Antigravity',
    location: '%USERPROFILE%\\.gemini\\antigravity\\mcp_config.json',
    snippet: mcpServersSnippet
  }
}

function CodingAgentsSection() {
  const appInfo = useStore((s) => s.appInfo)
  const showToast = useStore((s) => s.showToast)
  const [activeTool, setActiveTool] = useState<AgentToolId>('opencode')
  const tabListId = useId()

  const agentKit = appInfo?.agentKit
  const ready = agentKit !== undefined

  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`${label} copied`)
    } catch (error) {
      showToast(`Couldn't copy: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const openGuide = async (): Promise<void> => {
    if (!agentKit) return
    try {
      await window.deskmates.openPath(agentKit.guidePath)
    } catch (error) {
      showToast(`Couldn't open the guide: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = AGENT_TOOL_ORDER.indexOf(activeTool)
    const nextIndex =
      event.key === 'ArrowRight' ? (index + 1) % AGENT_TOOL_ORDER.length : (index - 1 + AGENT_TOOL_ORDER.length) % AGENT_TOOL_ORDER.length
    setActiveTool(AGENT_TOOL_ORDER[nextIndex])
  }

  const active = AGENT_TOOLS[activeTool]
  const snippet = active.snippet(agentKit?.commandPath ?? '')

  return (
    <section className="mt-8">
      <h2 className="caption">Coding agents</h2>
      <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
        <p className="text-[13px] text-ink-muted">
          Coding agents you connect to Deskmates, such as OpenCode, Antigravity, Cline or Freebuff, read this guide
          first, so they know how to use the Design tab and bot PCs.
        </p>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-4">
          <div className="min-w-0">
            <div className="text-[14px] font-medium">Guide</div>
            <div className="mt-1 truncate font-mono text-[12px] text-ink-muted" title={agentKit?.guidePath ?? ''}>
              {agentKit?.guidePath ?? '—'}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-outline r-concentric shrink-0"
            style={concentricVars(16)}
            disabled={!ready}
            onClick={() => void openGuide()}
          >
            Open guide
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-4">
          <div className="min-w-0">
            <div className="text-[14px] font-medium">Command</div>
            <div className="mt-1 truncate font-mono text-[12px] text-ink-muted" title={agentKit?.commandPath ?? ''}>
              {agentKit?.commandPath ?? '—'}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-outline r-concentric shrink-0"
            style={concentricVars(16)}
            disabled={!ready}
            aria-label="Copy command path"
            onClick={() => agentKit && void copy(agentKit.commandPath, 'Command path')}
          >
            Copy
          </button>
        </div>

        <div className="mt-4 border-t border-rule pt-4">
          <div className="text-[14px] font-medium">Add Deskmates tools to an agent</div>

          <div role="tablist" aria-label="Coding agent" className="segmented mt-3" onKeyDown={onTabKeyDown}>
            {AGENT_TOOL_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${tabListId}-tab-${id}`}
                aria-selected={activeTool === id}
                aria-controls={`${tabListId}-panel-${id}`}
                tabIndex={activeTool === id ? 0 : -1}
                className="segmented-item"
                onClick={() => setActiveTool(id)}
              >
                {AGENT_TOOLS[id].label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`${tabListId}-panel-${activeTool}`}
            aria-labelledby={`${tabListId}-tab-${activeTool}`}
            className="mt-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-ink-faint">{active.location}</span>
              <button
                type="button"
                className="btn btn-text shrink-0"
                disabled={!ready}
                aria-label={`Copy ${active.label} config`}
                onClick={() => void copy(snippet, `${active.label} config`)}
              >
                Copy
              </button>
            </div>
            <pre
              className="r-concentric mt-2 overflow-x-auto border border-rule bg-card p-3 font-mono text-[12px] text-ink"
              style={concentricVars(16)}
            >
              {snippet}
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}

/** A new key can unlock different models, so the Computer Use card's per-model checks start over. */
function forgetModelChecks(): void {
  try {
    localStorage.removeItem('deskmates.modelChecks')
  } catch {
    // Private storage: nothing was cached.
  }
}
