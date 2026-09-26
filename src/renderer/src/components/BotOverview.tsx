import { useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { SUGGESTED_AUTO_APPROVE_TOOLS } from '../lib/bots'
import { PROVIDERS, PROVIDER_LABELS, isLocalProvider } from '../../../shared/protocol'
import type { Bot, ProviderId } from '../../../shared/protocol'

/** Instructions, model, auto-approved tools and memory — everything on a bot's page except its name
 *  (renamed from the page header) and its PC/runs (their own sections). */
export function BotOverview({ bot }: { bot: Bot }) {
  const models = useStore((s) => s.models)
  const loadModels = useStore((s) => s.loadModels)
  const showToast = useStore((s) => s.showToast)

  const [instructions, setInstructions] = useState(bot.instructions)
  const [useDefault, setUseDefault] = useState(bot.model === null)
  const [modelProvider, setModelProvider] = useState<ProviderId | ''>(bot.model?.provider ?? '')
  const [modelId, setModelId] = useState(bot.model?.modelId ?? '')
  const [loadingModels, setLoadingModels] = useState(false)
  const [newTool, setNewTool] = useState('')

  const instructionsId = useId()
  const toolInputId = useId()
  const providerId = useId()
  const modelSelectId = useId()

  useEffect(() => {
    setInstructions(bot.instructions)
    setUseDefault(bot.model === null)
    setModelProvider(bot.model?.provider ?? '')
    setModelId(bot.model?.modelId ?? '')
    if (bot.model && !models[bot.model.provider]) void loadModels(bot.model.provider).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id])

  const saveInstructions = async (): Promise<void> => {
    if (instructions === bot.instructions) return
    try {
      await core.call('bots.update', { id: bot.id, instructions })
    } catch (error) {
      showToast(`Couldn't save the instructions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const setUseDefaultModel = (checked: boolean): void => {
    setUseDefault(checked)
    if (checked) {
      void core
        .call('bots.update', { id: bot.id, model: null })
        .catch((error) => showToast(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  const saveModel = async (provider: ProviderId, model: string): Promise<void> => {
    try {
      await core.call('bots.update', { id: bot.id, model: { provider, modelId: model } })
    } catch (error) {
      showToast(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const loadModelsFor = async (provider: ProviderId): Promise<void> => {
    setLoadingModels(true)
    try {
      await loadModels(provider)
    } catch (error) {
      showToast(`Couldn't load models: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingModels(false)
    }
  }

  const saveAutoApprove = async (next: string[]): Promise<void> => {
    try {
      await core.call('bots.update', { id: bot.id, autoApprove: next })
    } catch (error) {
      showToast(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const addTool = (name: string): void => {
    const trimmed = name.trim()
    if (!trimmed || bot.autoApprove.includes(trimmed)) return
    setNewTool('')
    void saveAutoApprove([...bot.autoApprove, trimmed])
  }

  const removeTool = (name: string): void => void saveAutoApprove(bot.autoApprove.filter((t) => t !== name))

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="caption">Instructions</h2>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          <label className="sr-only" htmlFor={instructionsId}>
            Bot instructions
          </label>
          <textarea
            id={instructionsId}
            className="input min-h-[140px] w-full resize-y"
            value={instructions}
            placeholder="What should this bot do, and how? For example: open example.com, read today's posts, and summarize anything new."
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => void saveInstructions()}
          />
        </div>
      </section>

      <section>
        <h2 className="caption">Model</h2>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          <label className="flex items-center gap-2 text-[14px] text-ink">
            <input
              type="checkbox"
              className="checkbox"
              checked={useDefault}
              onChange={(event) => setUseDefaultModel(event.target.checked)}
            />
            <span>Use the default model</span>
          </label>
          {!useDefault && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="field">
                  <label className="field-label" htmlFor={providerId}>
                    Provider
                  </label>
                  <select
                    id={providerId}
                    className="select"
                    value={modelProvider}
                    onChange={(event) => {
                      const provider = event.target.value as ProviderId | ''
                      setModelProvider(provider)
                      setModelId('')
                    }}
                  >
                    <option value="">Choose a provider</option>
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {PROVIDER_LABELS[provider]}
                        {provider === 'opencode' || provider === 'agy' ? ' (CLI, no key)' : ''}
                        {isLocalProvider(provider) ? ' (local, no key)' : ''}
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
                    value={modelId}
                    onChange={(event) => {
                      const model = event.target.value
                      setModelId(model)
                      if (modelProvider && model) void saveModel(modelProvider, model)
                    }}
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
              <button
                type="button"
                className="btn btn-outline mt-3"
                disabled={!modelProvider || loadingModels}
                onClick={() => modelProvider && void loadModelsFor(modelProvider)}
              >
                {loadingModels ? 'Loading…' : 'Load models'}
              </button>
            </>
          )}
        </div>
      </section>

      <section>
        <h2 className="caption">Tools it may use without asking</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          Everything else pauses for your approval during a run — unless the run is unattended and has no one to ask.
        </p>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          {bot.autoApprove.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {bot.autoApprove.map((tool) => (
                <span key={tool} className="chip">
                  <span className="font-mono">{tool}</span>
                  <button
                    type="button"
                    className="chip-close"
                    aria-label={`Remove ${tool}`}
                    onClick={() => removeTool(tool)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-ink-faint">Nothing yet — this bot asks before every risky action.</p>
          )}
          <div className="mt-3 flex items-end gap-2">
            <label className="sr-only" htmlFor={toolInputId}>
              Add a tool name
            </label>
            <input
              id={toolInputId}
              className="input flex-1"
              value={newTool}
              placeholder="Tool name, e.g. whatsapp_send"
              onChange={(event) => setNewTool(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addTool(newTool)
              }}
            />
            <button type="button" className="btn btn-outline shrink-0" onClick={() => addTool(newTool)}>
              Add
            </button>
          </div>
          {SUGGESTED_AUTO_APPROVE_TOOLS.some((t) => !bot.autoApprove.includes(t.name)) && (
            <div className="mt-2 flex flex-wrap gap-3">
              {SUGGESTED_AUTO_APPROVE_TOOLS.filter((t) => !bot.autoApprove.includes(t.name)).map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="btn btn-text px-0 text-[12px]"
                  title={t.hint}
                  onClick={() => addTool(t.name)}
                >
                  + {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="caption">Memory</h2>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
          <p className="text-[13px] text-ink-muted">
            Bot memory isn't connected on the backend yet. Once it is, facts this bot saves while it works will show
            up here.
          </p>
        </div>
      </section>
    </div>
  )
}
