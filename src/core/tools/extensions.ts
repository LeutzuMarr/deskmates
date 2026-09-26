/**
 * Tools that let the assistant install what the user asks for: MCP servers (connectors), skills and
 * plugins, into the same libraries the Extras tab manages.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './context'

const expandHome = (path: string): string => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path)

/** `path` as an absolute folder, relative paths meaning the project folder. */
function existingFolder(ctx: ToolContext, path: string): string {
  const full = resolve(ctx.root, expandHome(path.trim()))
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`There is no folder at ${full}.`)
  return full
}

const NEXT_MESSAGE = "Its tools are available to every agent from the user's next message on (this reply keeps the tools it started with)."

export function extensionTools(ctx: ToolContext) {
  return {
    list_extensions: tool({
      description: 'List the MCP servers (connectors), skills and plugins installed in Deskmates, with whether each is enabled.',
      inputSchema: z.object({}),
      execute: async () => ({
        mcp_servers: (ctx.connectors?.list() ?? []).map((c) => ({
          name: c.name,
          enabled: c.enabled,
          transport: c.transport,
          target: c.transport === 'http' ? c.url : [c.command, ...(c.args ?? [])].join(' ')
        })),
        skills: (ctx.skills?.list() ?? []).map((s) => ({ name: s.name, enabled: s.enabled, source: s.source })),
        plugins: (ctx.plugins?.list() ?? []).map((p) => ({ name: p.name, source: p.source }))
      })
    }),

    add_mcp_server: tool({
      description:
        'Install an MCP server as a Deskmates connector so every agent gets its tools. Give either a local server (command, args, env) or a remote one (url), or config_path to import every server from an mcp config JSON file ({"mcpServers": {...}}, as Claude Desktop, Claude Code, Cursor or Antigravity write). If the server needs installing first (git clone, pip, npm, uv), do that with the shell before calling this. Then it connects to the server to check it works and reports its tools.',
      inputSchema: z.object({
        name: z.string().optional().describe('Short name for the server, e.g. "davinci-resolve". Required unless config_path is given.'),
        command: z.string().optional().describe('Program that starts a local (stdio) server, e.g. "npx", "uvx" or a full path to python.exe.'),
        args: z.array(z.string()).optional().describe('Arguments for the command.'),
        env: z.record(z.string(), z.string()).optional().describe('Environment variables the server needs.'),
        url: z.string().optional().describe('URL of a remote (streamable HTTP) server, instead of command.'),
        config_path: z.string().optional().describe('Path of an mcp config JSON file to import all its servers from.')
      }),
      execute: async ({ name, command, args, env, url, config_path }) => {
        const connectors = ctx.connectors
        if (!connectors) throw new Error('Connectors are not available in this setup.')
        if (config_path) {
          const before = new Set(connectors.list().map((c) => c.id))
          const added = connectors.importMcpConfig(config_path).filter((c) => !before.has(c.id))
          await connectors.refresh()
          return { added: added.map((c) => c.name), note: added.length ? NEXT_MESSAGE : 'Every server in that file was already installed (or used an unsupported transport).' }
        }
        if (!name?.trim()) throw new Error('Give the server a name.')
        if (!command?.trim() && !url?.trim()) throw new Error('Give either a command (local server) or a url (remote server).')
        if (connectors.list().some((c) => c.name === name.trim())) throw new Error(`A connector named "${name.trim()}" already exists. Pick another name.`)
        const created = connectors
          .create(url?.trim() ? { name: name.trim(), transport: 'http', url: url.trim() } : { name: name.trim(), transport: 'stdio', command: command!.trim(), args, env })
          .find((c) => c.name === name.trim())
        await connectors.refresh()
        try {
          const tools = created ? await connectors.test(created.id) : []
          return { installed: name.trim(), tools: tools.slice(0, 60), tool_count: tools.length, note: NEXT_MESSAGE }
        } catch (error) {
          return {
            installed: name.trim(),
            connected: false,
            error: error instanceof Error ? error.message : String(error),
            note: 'Saved, but it could not connect yet. Fix the cause (for example start the app it controls) and it reconnects on its own; the user can also test it in Extras → Connectors.'
          }
        }
      }
    }),

    install_skill: tool({
      description:
        'Install skills into the Deskmates skills library so every agent can load them. Give a folder holding a SKILL.md, or a folder whose subfolders each hold one (all of them are imported). To install skills from GitHub, clone the repo with the shell first and pass the skills folder, or use install_plugin.',
      inputSchema: z.object({ path: z.string().describe('Folder of the skill, or of several skills. Relative paths are inside the project folder.') }),
      execute: async ({ path }) => {
        const skills = ctx.skills
        if (!skills) throw new Error('Skills are not available in this setup.')
        const before = new Set(skills.list().map((s) => s.name))
        const after = skills.import(existingFolder(ctx, path))
        const added = after.filter((s) => !before.has(s.name)).map((s) => s.name)
        return { added, total: after.length, note: 'Installed skills are listed to every agent from the next message on.' }
      }
    }),

    install_plugin: tool({
      description:
        'Install a plugin: a GitHub repo ("owner/repo" or its https URL) or a local folder. It is copied into the Deskmates plugins folder and the skills it bundles join the skills library.',
      inputSchema: z.object({ source: z.string().describe('"owner/repo", a GitHub URL, or a folder path.') }),
      execute: async ({ source }) => {
        const plugins = ctx.plugins
        if (!plugins) throw new Error('Plugins are not available in this setup.')
        const trimmed = source.trim()
        const local = isAbsolute(expandHome(trimmed)) || trimmed.startsWith('.') ? existingFolder(ctx, trimmed) : trimmed
        const list = await plugins.install(local)
        return { plugins: list.map((p) => p.name), skills: ctx.skills?.list().length ?? 0 }
      }
    })
  }
}
