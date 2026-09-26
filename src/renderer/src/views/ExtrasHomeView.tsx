import { useState } from 'react'
import { Cable, Package, Sparkles } from 'lucide-react'
import { useStore } from '../lib/store'
import { InstallPluginDialog } from '../components/InstallPluginDialog'
import { ImportSkillDialog } from '../components/ImportSkillDialog'
import { ConnectorDialog } from '../components/ConnectorDialog'
import { ImportMcpConfigDialog } from '../components/ImportMcpConfigDialog'
import type { Connector } from '../../../shared/protocol'

export function ExtrasHomeView() {
  const plugins = useStore((s) => s.plugins)
  const skills = useStore((s) => s.skills)
  const connectors = useStore((s) => s.connectors)
  const removePlugin = useStore((s) => s.removePlugin)
  const removeSkill = useStore((s) => s.removeSkill)
  const setSkillEnabled = useStore((s) => s.setSkillEnabled)
  const deleteConnector = useStore((s) => s.deleteConnector)
  const [installOpen, setInstallOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [connectorDialog, setConnectorDialog] = useState<Connector | 'new' | null>(null)
  const [importConfigOpen, setImportConfigOpen] = useState(false)

  const pluginName = (plugin: (typeof plugins)[number]): string => plugin.name

  const uninstall = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Uninstall "${name}"? Its bundled skills stay in your library.`)) return
    await removePlugin(id)
  }

  const forget = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Remove the skill "${name}"? This deletes its folder from the library.`)) return
    await removeSkill(id)
  }

  const removeConnector = async (connector: Connector): Promise<void> => {
    if (!window.confirm(`Remove the connector "${connector.name}"? Tools it exposed stop being available.`)) return
    await deleteConnector(connector.id)
  }

  const connectorDetail = (connector: Connector): string =>
    connector.transport === 'http' ? (connector.url ?? '') : [connector.command, ...(connector.args ?? [])].filter(Boolean).join(' ')

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-10">
        <h1 className="font-serif text-[44px] leading-[1.1]">Extras</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          Skills give the assistant repeatable workflows to follow on demand. Plugins bundle skills, and
          connectors give the assistant and your bots MCP tools to call.
        </p>

        <div className="mt-8 flex items-center justify-between">
          <h2 className="caption">Skills</h2>
          <button type="button" className="btn btn-outline" onClick={() => setImportOpen(true)}>
            Import a skill
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-faint">
          A skill is a folder holding a SKILL.md (open Agent Skills format). Enabled skills can be loaded by the
          assistant whenever a task matches them.
        </p>
        {skills.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-5 text-[13px] text-ink-faint">
            No skills yet. Import a folder with a SKILL.md, or install a plugin that bundles some.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {skills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between gap-3 rounded-3xl border border-rule bg-card p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Sparkles size={18} className="shrink-0 text-ink-faint" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="truncate font-serif text-[16px]">{skill.name}</div>
                    <div className="mt-0.5 truncate text-[12px] text-ink-faint" title={skill.source}>
                      {skill.source.startsWith('plugin:') ? `bundled by ${skill.source.slice('plugin:'.length)}` : skill.source}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className={skill.enabled ? 'btn btn-ivory' : 'btn btn-outline'}
                    onClick={() => void setSkillEnabled(skill.id, !skill.enabled)}
                  >
                    {skill.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button type="button" className="btn btn-text" onClick={() => void forget(skill.id, skill.name)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-10 flex items-center justify-between">
          <h2 className="caption">Connectors</h2>
          <div className="flex gap-2">
            <button type="button" className="btn btn-outline" onClick={() => setImportConfigOpen(true)}>
              Import mcp_config
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setConnectorDialog('new')}>
              Add a connector
            </button>
          </div>
        </div>
        <p className="mt-1 text-[12px] text-ink-faint">
          A connector is an MCP server. Its tools show up to the assistant and your bots as mcp__-named
          tools.
        </p>
        {connectors.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-5 text-[13px] text-ink-faint">
            No connectors yet. Add an MCP server by hand, or import your mcp_config.json in one move.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {connectors.map((connector) => (
              <div key={connector.id} className="flex items-center justify-between gap-3 rounded-3xl border border-rule bg-card p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Cable size={18} className="shrink-0 text-ink-faint" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="truncate font-serif text-[16px]">{connector.name}</div>
                    <div className="mt-0.5 truncate text-[12px] text-ink-faint" title={connectorDetail(connector)}>
                      {connector.transport === 'http' ? 'http' : 'stdio'} — {connectorDetail(connector) || 'no command'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" className="btn btn-text" onClick={() => setConnectorDialog(connector)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-text" onClick={() => void removeConnector(connector)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-10 flex items-center justify-between">
          <h2 className="caption">Plugins</h2>
          <button type="button" className="btn btn-outline" onClick={() => setInstallOpen(true)}>
            Install a plugin
          </button>
        </div>
        <p className="mt-1 text-[12px] text-ink-faint">
          A plugin is a folder or a GitHub repo that bundles skills. Installing copies it into the library and
          imports its skills; uninstalling keeps the skills.
        </p>
        {plugins.length === 0 ? (
          <div className="mt-3 rounded-3xl border border-rule bg-card p-5 text-[13px] text-ink-faint">
            No plugins yet. Install one from a folder or GitHub repo.
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {plugins.map((plugin) => (
              <div key={plugin.id} className="flex items-center justify-between gap-3 rounded-3xl border border-rule bg-card p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Package size={18} className="shrink-0 text-ink-faint" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="truncate font-serif text-[16px]">{plugin.name}</div>
                    <div className="mt-0.5 truncate text-[12px] text-ink-faint" title={plugin.source}>
                      {plugin.source}
                    </div>
                  </div>
                </div>
                <button type="button" className="btn btn-text shrink-0" onClick={() => void uninstall(plugin.id, pluginName(plugin))}>
                  Uninstall
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <InstallPluginDialog open={installOpen} onClose={() => setInstallOpen(false)} />
      <ImportSkillDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ConnectorDialog
        open={connectorDialog !== null}
        onClose={() => setConnectorDialog(null)}
        connector={connectorDialog === 'new' ? undefined : connectorDialog ?? undefined}
      />
      <ImportMcpConfigDialog open={importConfigOpen} onClose={() => setImportConfigOpen(false)} />
    </main>
  )
}