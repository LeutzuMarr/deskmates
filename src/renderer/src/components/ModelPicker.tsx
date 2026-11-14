import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { useDismissableMenu } from '../lib/useMenu'
import { PROVIDER_LABELS } from '../../../shared/protocol'
import { freebuffModelLabel } from '../../../shared/freebuff'
import type { ModelRef, ProviderId } from '../../../shared/protocol'

function modelLabel(provider: ProviderId, modelId: string): string {
  return provider === 'freebuff' ? freebuffModelLabel(modelId) : modelId
}

/**
 * The composer's model chip. Opens a picker of the current provider's models, the way chat apps put
 * the model switch next to the message box, and saves the choice on the project. Other providers
 * and keys stay in Project settings, linked at the bottom.
 */
export function ModelPicker({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const defaultModel = useStore((s) => s.settings?.defaultModel ?? null)
  const models = useStore((s) => s.models)
  const loadModels = useStore((s) => s.loadModels)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const menuRef = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false))

  const current: ModelRef | null = project?.model ?? defaultModel
  const provider = current?.provider
  const list = provider ? models[provider] : undefined

  useEffect(() => {
    if (!open) return
    setFilter('')
    setLoadError(null)
    requestAnimationFrame(() => filterRef.current?.focus())
    if (!provider) return
    // Freebuff's models change with its updates, so its list is re-read every time the picker opens.
    const known = useStore.getState().models[provider]
    if (known && provider !== 'freebuff') return
    setLoading(!known)
    loadModels(provider)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [open, provider, loadModels])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const all = list ?? []
    return (needle ? all.filter((m) => m.toLowerCase().includes(needle)) : all).slice(0, 200)
  }, [list, filter])

  const choose = async (model: ModelRef | null): Promise<void> => {
    setOpen(false)
    try {
      await core.call('projects.update', { id: projectId, model })
    } catch (error) {
      showToast(`Couldn't change the model: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const label = current ? modelLabel(current.provider, current.modelId) : 'No model selected'

  return (
    <div className="relative min-w-0" ref={menuRef}>
      <button
        type="button"
        className="no-drag r-concentric flex max-w-full items-center gap-1 border border-rule px-2.5 py-1 text-[12px] text-ink-muted hover:bg-oat hover:text-ink"
        style={concentricVars(8)}
        aria-label={`Model: ${current?.modelId ?? 'not set'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${PROVIDER_LABELS[current.provider]} · ${current.modelId}` : 'Choose a model'}
        onClick={() => (current ? setOpen((v) => !v) : navigate({ name: 'project-settings', projectId }))}
      >
        <span className="max-w-[200px] truncate">{label}</span>
        {current && <ChevronDown size={12} aria-hidden="true" className="shrink-0" />}
      </button>
      {open && current && provider && (
        <div className="menu bottom-full left-0 mb-2 w-[320px]" role="dialog" aria-label="Choose a model">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-ink-faint">{PROVIDER_LABELS[provider]}</div>
          {(list?.length ?? 0) > 8 && (
            <input
              ref={filterRef}
              className="input mb-1 py-1.5 text-[13px]"
              placeholder="Filter models"
              aria-label="Filter models"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && shown[0]) void choose({ provider, modelId: shown[0] })
              }}
            />
          )}
          <div role="listbox" aria-label="Models" className="scroll-area max-h-[260px] overflow-y-auto">
            {defaultModel && project?.model && (
              <button type="button" role="option" aria-selected={false} className="menu-item" onClick={() => void choose(null)}>
                <span className="w-[14px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">Use default · {modelLabel(defaultModel.provider, defaultModel.modelId)}</span>
              </button>
            )}
            {loading && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-ink-muted">
                <Loader2 size={13} className="spin" aria-hidden="true" /> Loading models…
              </div>
            )}
            {loadError && <div className="px-2.5 py-2 text-[12px] text-brick">{loadError}</div>}
            {shown.map((modelId) => {
              const selected = modelId === current.modelId
              return (
                <button
                  key={modelId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="menu-item"
                  onClick={() => void choose({ provider, modelId })}
                >
                  <span className="flex w-[14px] shrink-0 justify-center">{selected && <Check size={13} aria-hidden="true" />}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{modelLabel(provider, modelId)}</span>
                </button>
              )
            })}
            {!loading && !loadError && list && shown.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-ink-faint">No models match.</div>
            )}
          </div>
          <div className="mt-1 border-t border-rule pt-1">
            <button
              type="button"
              className="menu-item text-ink-muted"
              onClick={() => {
                setOpen(false)
                navigate({ name: 'project-settings', projectId })
              }}
            >
              Other providers and project settings…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
