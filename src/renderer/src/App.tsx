import { useEffect } from 'react'
import { useStore } from './lib/store'
import { applyAppearance } from './lib/appearance'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { DesignSidebar } from './components/DesignSidebar'
import { BotsSidebar } from './components/BotsSidebar'
import { AgentsSidebar } from './components/AgentsSidebar'
import { ExtrasSidebar } from './components/ExtrasSidebar'
import { Toast } from './components/Toast'
import { HomeView } from './views/HomeView'
import { ProjectView } from './views/ProjectView'
import { TaskView } from './views/TaskView'
import { SettingsView } from './views/SettingsView'
import { ProjectSettingsView } from './views/ProjectSettingsView'
import { DesignHomeView } from './views/DesignHomeView'
import { DesignView } from './views/DesignView'
import { BotsHomeView } from './views/BotsHomeView'
import { BotView } from './views/BotView'
import { AgentsHomeView } from './views/AgentsHomeView'
import { AgentsSessionView } from './views/AgentsSessionView'
import { AgentsAttachView } from './views/AgentsAttachView'
import { ExtrasHomeView } from './views/ExtrasHomeView'

export function App() {
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const tab = useStore((s) => s.tab)
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    applyAppearance(settings)
  }, [settings])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <TitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        {tab === 'design' ? (
          <DesignSidebar />
        ) : tab === 'bots' ? (
          <BotsSidebar />
        ) : tab === 'agents' ? (
          <AgentsSidebar />
        ) : tab === 'extras' ? (
          <ExtrasSidebar />
        ) : (
          <Sidebar />
        )}
        <main className="min-w-0 flex-1">
          {view.name === 'home' && <HomeView />}
          {view.name === 'project' && <ProjectView projectId={view.projectId} />}
          {view.name === 'task' && <TaskView projectId={view.projectId} taskId={view.taskId} />}
          {view.name === 'settings' && <SettingsView />}
          {view.name === 'project-settings' && <ProjectSettingsView projectId={view.projectId} />}
          {view.name === 'design-home' && <DesignHomeView />}
          {view.name === 'design' && <DesignView key={view.projectId} projectId={view.projectId} />}
          {view.name === 'bots-home' && <BotsHomeView />}
          {view.name === 'bot' && <BotView key={view.botId} botId={view.botId} />}
          {view.name === 'agents-home' && <AgentsHomeView />}
          {view.name === 'agents-session' && <AgentsSessionView key={view.sessionId} sessionId={view.sessionId} />}
          {view.name === 'agents-attach' && <AgentsAttachView key={view.sessionId} sessionId={view.sessionId} />}
          {view.name === 'extras-home' && <ExtrasHomeView />}
        </main>
      </div>
      <Toast />
    </div>
  )
}