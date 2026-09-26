import { useState } from 'react'
import { Ellipsis, Plus, Settings } from 'lucide-react'
import { useStore } from '../lib/store'
import { useDismissableMenu } from '../lib/useMenu'
import { CreateBotDialog } from './CreateBotDialog'
import { PcStatusMark } from './PcStatusMark'
import type { Bot, PcState } from '../../../shared/protocol'

export function BotsSidebar() {
  const bots = useStore((s) => s.bots)
  const botPcs = useStore((s) => s.botPcs)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const deleteBot = useStore((s) => s.deleteBot)
  const [createOpen, setCreateOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const selectedBotId = view.name === 'bot' ? view.botId : null
  const sorted = [...bots].sort((a, b) => a.name.localeCompare(b.name))

  const remove = async (bot: Bot): Promise<void> => {
    setMenuFor(null)
    if (!window.confirm(`Delete "${bot.name}"? This removes the bot, its runs and its memory.`)) return
    const ok = await deleteBot(bot.id)
    if (ok && selectedBotId === bot.id) navigate({ name: 'bots-home' })
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col bg-sidebar">
      <div className="scroll-area flex flex-1 flex-col overflow-y-auto p-2">
        <div className="sidebar-nav">
          <button type="button" className="sidebar-row" onClick={() => setCreateOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            <span>New bot</span>
          </button>
        </div>

        <div className="caption mt-4 px-3">Bots</div>
        <div className="sidebar-nav mt-1">
          {sorted.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              active={selectedBotId === bot.id}
              pcState={botPcs[bot.id]?.state ?? 'absent'}
              menuOpen={menuFor === bot.id}
              onOpen={() => navigate({ name: 'bot', botId: bot.id })}
              onToggleMenu={() => setMenuFor((current) => (current === bot.id ? null : bot.id))}
              onCloseMenu={() => setMenuFor(null)}
              onDelete={() => void remove(bot)}
            />
          ))}
          {sorted.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-faint">No bots yet.</p>}
        </div>
      </div>

      <div className="sidebar-nav border-t border-rule p-2">
        <button type="button" className="sidebar-row" onClick={() => navigate({ name: 'settings' })}>
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>

      <CreateBotDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </aside>
  )
}

interface BotRowProps {
  bot: Bot
  active: boolean
  pcState: PcState
  menuOpen: boolean
  onOpen: () => void
  onToggleMenu: () => void
  onCloseMenu: () => void
  onDelete: () => void
}

function BotRow({ bot, active, pcState, menuOpen, onOpen, onToggleMenu, onCloseMenu, onDelete }: BotRowProps) {
  const menuRef = useDismissableMenu<HTMLDivElement>(menuOpen, onCloseMenu)

  return (
    <div className="relative">
      <div
        className={`sidebar-row ${active ? 'sidebar-row-active' : ''}`}
        onContextMenu={(event) => {
          event.preventDefault()
          onToggleMenu()
        }}
      >
        <button type="button" className="sidebar-row-main" onClick={onOpen} title={bot.name}>
          <PcStatusMark state={pcState} />
          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
        </button>
        <button
          type="button"
          className="btn-icon shrink-0"
          aria-label={`More options for ${bot.name}`}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      </div>
      {menuOpen && (
        <div ref={menuRef} role="menu" aria-label={`${bot.name} options`} className="menu" style={{ top: '100%', right: 8 }}>
          <button type="button" role="menuitem" className="menu-item" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
