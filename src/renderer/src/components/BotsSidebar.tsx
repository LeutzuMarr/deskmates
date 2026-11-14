import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useStore } from '../lib/store'
import { CreateBotDialog } from './CreateBotDialog'
import { SidebarEmpty, SidebarFrame, SidebarRow } from './SidebarParts'
import { pcMark } from './StatusMark'
import type { Bot } from '../../../shared/protocol'

export function BotsSidebar() {
  const bots = useStore((s) => s.bots)
  const botPcs = useStore((s) => s.botPcs)
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  const deleteBot = useStore((s) => s.deleteBot)
  const [createOpen, setCreateOpen] = useState(false)

  const selectedBotId = view.name === 'bot' ? view.botId : null
  const sorted = [...bots].sort((a, b) => a.name.localeCompare(b.name))

  const remove = async (bot: Bot): Promise<void> => {
    if (!window.confirm(`Delete "${bot.name}"? This removes the bot, its runs and its memory.`)) return
    const ok = await deleteBot(bot.id)
    if (ok && selectedBotId === bot.id) navigate({ name: 'bots-home' })
  }

  return (
    <SidebarFrame>
      <div className="sidebar-nav">
        <button type="button" className="sidebar-row" onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden="true" />
          <span>New bot</span>
        </button>
      </div>

      <div className="caption mt-4 px-3">Bots</div>
      <div className="sidebar-nav mt-1">
        {sorted.map((bot) => (
          <SidebarRow
            key={bot.id}
            label={bot.name}
            active={selectedBotId === bot.id}
            mark={pcMark(botPcs[bot.id]?.state ?? 'absent')}
            onOpen={() => navigate({ name: 'bot', botId: bot.id })}
            menu={[{ label: 'Delete', danger: true, onSelect: () => void remove(bot) }]}
          />
        ))}
        {sorted.length === 0 && <SidebarEmpty>No bots yet.</SidebarEmpty>}
      </div>

      <CreateBotDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </SidebarFrame>
  )
}
