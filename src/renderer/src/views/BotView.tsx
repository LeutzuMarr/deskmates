import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { PcStatusLine } from '../components/PcStatusMark'
import { BotOverview } from '../components/BotOverview'
import { BotPcPanel } from '../components/BotPcPanel'
import { BotRuns } from '../components/BotRuns'

type Section = 'overview' | 'pc' | 'runs'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pc', label: 'PC' },
  { id: 'runs', label: 'Runs' }
]

export function BotView({ botId }: { botId: string }) {
  const bots = useStore((s) => s.bots)
  const botPcs = useStore((s) => s.botPcs)
  const engineStatus = useStore((s) => s.engineStatus)
  const navigate = useStore((s) => s.navigate)
  const showToast = useStore((s) => s.showToast)
  const deleteBot = useStore((s) => s.deleteBot)

  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [section, setSection] = useState<Section>('overview')

  const bot = bots.find((b) => b.id === botId)
  const pc = botPcs[botId]

  // A fresh bot page always opens on Overview, even if the previous bot was left on Runs.
  useEffect(() => setSection('overview'), [botId])

  if (!bot) {
    return (
      <main className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[14px] text-ink-faint">This bot was removed.</p>
      </main>
    )
  }

  const startRename = (): void => {
    setDraft(bot.name)
    setRenaming(true)
  }

  const saveRename = async (): Promise<void> => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === bot.name) return
    try {
      await core.call('bots.update', { id: bot.id, name })
    } catch (error) {
      showToast(`Couldn't rename the bot: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${bot.name}"? This removes the bot, its runs and its memory.`)) return
    const ok = await deleteBot(bot.id)
    if (ok) navigate({ name: 'bots-home' })
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = SECTIONS.findIndex((s) => s.id === section)
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length : (index - 1 + SECTIONS.length) % SECTIONS.length
    setSection(SECTIONS[nextIndex].id)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-rule px-8 py-4">
        <div className="min-w-0">
          {renaming ? (
            <label className="field">
              <span className="sr-only">Bot name</span>
              <input
                autoFocus
                className="input w-[280px]"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => void saveRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveRename()
                  if (event.key === 'Escape') setRenaming(false)
                }}
              />
            </label>
          ) : (
            <h1
              className="truncate font-serif text-[24px] leading-tight"
              title="Double-click to rename"
              onDoubleClick={startRename}
            >
              {bot.name}
            </h1>
          )}
          <div className="mt-1 text-[12px] text-ink-muted">
            <PcStatusLine state={pc?.state ?? 'absent'} />
          </div>
        </div>
        <button type="button" className="btn btn-outline shrink-0" onClick={() => void remove()}>
          <Trash2 size={14} aria-hidden="true" className="mr-1.5" />
          Delete bot
        </button>
      </header>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-8">
          <div role="tablist" aria-label="Bot sections" className="segmented" onKeyDown={onTabKeyDown}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`bot-tab-${s.id}`}
                aria-selected={section === s.id}
                aria-controls={`bot-panel-${s.id}`}
                tabIndex={section === s.id ? 0 : -1}
                className="segmented-item"
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`bot-panel-${section}`} aria-labelledby={`bot-tab-${section}`} className="mt-6">
            {section === 'overview' && <BotOverview bot={bot} />}
            {section === 'pc' && (
              <BotPcPanel
                bot={bot}
                pc={pc}
                engineReady={engineStatus?.ready ?? false}
                onGoToSetup={() => navigate({ name: 'bots-home' })}
              />
            )}
            {section === 'runs' && <BotRuns bot={bot} />}
          </div>
        </div>
      </div>
    </div>
  )
}
