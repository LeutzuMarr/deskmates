import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { PROVIDERS, PROVIDER_LABELS, isLocalProvider } from '../../../shared/protocol'
import type { Memory, ProviderId } from '../../../shared/protocol'

export function ProjectSettingsView({ projectId }: { projectId: string }) {
  const projects = useStore((s) => s.projects)
  const memories = useStore((s) => s.memories[projectId])
  const models = useStore((s) => s.models)
  const loadModels = useStore((s) => s.loadModels)
  const addMemory = useStore((s) => s.addMemory)
  const deleteMemory = useStore((s) => s.deleteMemory)
  const showToast = useStore((s) => s.showToast)
  const navigate = useStore((s) => s.navigate)

  const project = projects.find((p) => p.id === projectId)

  const [name, setName] = useState('')
  const [useDefault, setUseDefault] = useState(true)
  const [modelProvider, setModelProvider] = useState<ProviderId | ''>('')
  const [modelId, setModelId] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [newMemory, setNewMemory] = useState('')

  useEffect(() => {
    if (project) {
      setName(project.name)
      setUseDefault(project.model === null)
      if (project.model) {
        setModelProvider(project.model.provider)
        setModelId(project.model.modelId)
        if (!models[project.model.provider]) {
          void loadModels(project.model.provider).catch(() => undefined)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  useEffect(() => {
    void (async () => {
      try {
        const result = await core.call('projects.instructions.get', { id: projectId })
        setInstructions(result.content)
      } catch (error) {
        showToast(`Couldn't load the instructions: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  if (!project) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This project was removed.</p>
      </main>
    )
  }

  const saveName = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === project.name) return
    try {
      await core.call('projects.update', { id: projectId, name: trimmed })
    } catch (error) {
      showToast(`Couldn't save the name: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveInstructions = async (): Promise<void> => {
    try {
      await core.call('projects.instructions.set', { id: projectId, content: instructions })
    } catch (error) {
      showToast(`Couldn't save the instructions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const setUseDefaultModel = (checked: boolean): void => {
    setUseDefault(checked)
    if (checked) {
      void core
        .call('projects.update', { id: projectId, model: null })
        .catch((error) => showToast(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  const saveModelOverride = async (provider: ProviderId, model: string): Promise<void> => {
    try {
      await core.call('projects.update', { id: projectId, model: { provider, modelId: model } })
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

  const add = async (): Promise<void> => {
    const content = newMemory.trim()
    if (!content) return
    const list = await addMemory(projectId, content)
    if (list) setNewMemory('')
  }

  const forget = async (memory: Memory): Promise<void> => {
    await deleteMemory(memory.id, projectId)
  }

  const removeProject = async (): Promise<void> => {
    const confirmed = window.confirm('Remove this project from Deskmates? Your files stay where they are.')
    if (!confirmed) return
    try {
      await core.call('projects.delete', { id: projectId })
      navigate({ name: 'home' })
    } catch (error) {
      showToast(`Couldn't remove the project: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-8">
        <h1 className="font-serif text-[24px] leading-tight">Project settings</h1>
        <p className="mt-1 truncate font-mono text-[12px] text-ink-muted">{project.folder}</p>

        <section className="mt-8">
          <h2 className="caption">Project name</h2>
          <div className="mt-3 flex items-end gap-2">
            <label className="sr-only" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void saveName()}
            />
            <button type="button" className="btn btn-outline" onClick={() => void saveName()}>
              Save name
            </button>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="caption">Model</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <label className="flex items-center gap-2 text-[14px] text-ink">
              <input
                type="checkbox"
                className="checkbox"
                checked={useDefault}
                onChange={(event) => setUseDefaultModel(event.target.checked)}
              />
              <span>Use default model</span>
            </label>
            {!useDefault && (
              <>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div className="field">
                    <label className="field-label" htmlFor="project-model-provider">
                      Provider
                    </label>
                    <select
                      id="project-model-provider"
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
                          {provider === 'opencode' || provider === 'agy' ? ' (CLI)' : ''}
                          {isLocalProvider(provider) ? ' (local)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="project-model-id">
                      Model
                    </label>
                    <select
                      id="project-model-id"
                      className="select"
                      value={modelId}
                      onChange={(event) => {
                        const model = event.target.value
                        setModelId(model)
                        if (modelProvider && model) void saveModelOverride(modelProvider, model)
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

        <section className="mt-8">
          <h2 className="caption">Project instructions (DESKMATES.md)</h2>
          <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
            <label className="sr-only" htmlFor="project-instructions">
              Project instructions (DESKMATES.md)
            </label>
            <textarea
              id="project-instructions"
              className="input min-h-[96px] w-full resize-y"
              value={instructions}
              placeholder="These rules apply to this project, on top of the global instructions."
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
          <div className="flex items-center justify-between">
            <h2 className="caption">Memories</h2>
            <button type="button" className="btn btn-outline" onClick={() => void add()}>
              Add memory
            </button>
          </div>
          {memories && memories.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {memories.map((memory) => (
                <li
                  key={memory.id}
                  className="flex items-start justify-between gap-3 rounded-2xl border border-rule bg-card px-4 py-3"
                >
                  <span className="text-[13px] leading-snug text-ink-muted">{memory.content}</span>
                  <button
                    type="button"
                    className="btn btn-text shrink-0 px-0 text-[13px]"
                    aria-label={`Forget: ${memory.content}`}
                    onClick={() => void forget(memory)}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-ink-faint">No memories yet.</p>
          )}
          <div className="mt-3 flex items-end gap-2">
            <label className="sr-only" htmlFor="new-memory">
              New memory
            </label>
            <input
              id="new-memory"
              className="input flex-1"
              value={newMemory}
              placeholder="Thing to remember about this project"
              onChange={(event) => setNewMemory(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void add()
              }}
            />
          </div>
        </section>

        <section className="mt-10 border-t border-rule pt-6">
          <button type="button" className="btn btn-outline text-brick" onClick={() => void removeProject()}>
            <Trash2 size={14} aria-hidden="true" className="mr-1.5" />
            Remove project
          </button>
        </section>
      </div>
    </main>
  )
}