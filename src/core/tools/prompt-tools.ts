/**
 * The tools the user's operating prompt (prompts/my-prompt/my-prompt.md) tells agents to use, under
 * the names and with the inputs the prompt teaches. Each is built from the JSON schema in the
 * prompt's "Tools" section (see promptToolSpecs) and runs on Deskmates' own machinery: file and shell
 * tools, the web, a shared memory folder, past chats, MCP connectors, and inline widgets drawn in the
 * chat. A tool only exists when the prompt describes it and nothing else in the run has its name.
 *
 * Not built here: the prompt's mcp__Gmail__*, mcp__Google_Calendar__*, mcp__Google_Drive__* and
 * mcp__Claude_Docs__* tools, which come from connectors (the Google preset in the Connectors dialog
 * adds Gmail, Calendar and Drive under the connector's own tool names).
 */
import { existsSync, statSync } from 'node:fs'
import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { jsonSchemaToZod } from '../connectors/schema'
import { promptToolSpecs } from '../engine/my-prompt'
import { resolveInside } from '../fs/safe-path'
import type { ToolContext } from './context'
import { callTool } from './cowork'
import { MemoryFiles } from './memory-files'
import { webFetchText, webSearchResults } from './web'
import { displayBody, imageGallery, saveWidget, widgetPage } from './widgets'
import { WIDGET_TOOL_NAMES } from '../../shared/widgets'
import { join } from 'node:path'

const USER_AGENT = 'Deskmates/1.0 (desktop assistant)'
const DISPLAY_TOOLS = [
  'chart_display_v0',
  'comparison_card_display_v0',
  'featured_card_display_v0',
  'itinerary_display_v0',
  'link_preview_display_v0',
  'message_compose_v1',
  'options_card_display_v0',
  'places_list_display_v0',
  'places_map_display_v0',
  'product_carousel_display_v0',
  'quiz_display_v0',
  'recipe_display_v0',
  'show_recommendation_cards',
  'step_card_display_v0',
  'translation_display_v0'
] as const

/** Tools whose result the chat draws as an inline widget. */
export const WIDGET_TOOLS: ReadonlySet<string> = new Set(WIDGET_TOOL_NAMES)

type Input = Record<string, unknown>
type Run = (input: Input, options: { abortSignal?: AbortSignal }) => Promise<unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}.`)
  return response.json()
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** ESPN's sport path for each league the prompt's fetch_sports_data offers. */
const ESPN_LEAGUES: Record<string, string> = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
  mlb: 'baseball/mlb',
  wnba: 'basketball/wnba',
  ncaafb: 'football/college-football',
  ncaamb: 'basketball/mens-college-basketball',
  ncaawb: 'basketball/womens-college-basketball',
  epl: 'soccer/eng.1',
  la_liga: 'soccer/esp.1',
  serie_a: 'soccer/ita.1',
  bundesliga: 'soccer/ger.1',
  ligue_1: 'soccer/fra.1',
  mls: 'soccer/usa.1',
  champions_league: 'soccer/uefa.champions',
  world_cup: 'soccer/fifa.world',
  tennis: 'tennis/atp',
  golf: 'golf/pga',
  nascar: 'racing/nascar-premier',
  mma: 'mma/ufc'
}

/** The parts of an ESPN scoreboard worth showing: each game, its state and score. */
function scoreboard(body: unknown, team: string): unknown {
  const events = ((body as { events?: unknown[] }).events ?? []) as Array<Record<string, any>>
  const wanted = team.trim().toLowerCase()
  return events
    .map((event) => {
      const competition = event.competitions?.[0] ?? {}
      return {
        game_id: event.id,
        name: event.name,
        date: event.date,
        status: event.status?.type?.detail ?? event.status?.type?.description,
        competitors: (competition.competitors ?? []).map((c: Record<string, any>) => ({
          team: c.team?.displayName ?? c.athlete?.displayName,
          home_away: c.homeAway,
          score: c.score,
          winner: c.winner,
          record: c.records?.[0]?.summary
        })),
        venue: competition.venue?.fullName
      }
    })
    .filter((game) => !wanted || JSON.stringify(game.competitors).toLowerCase().includes(wanted) || String(game.name).toLowerCase().includes(wanted))
}

function standings(body: unknown): unknown {
  const groups = ((body as { children?: unknown[] }).children ?? [body]) as Array<Record<string, any>>
  return groups.map((group) => ({
    group: group.name ?? group.abbreviation,
    teams: (group.standings?.entries ?? []).map((entry: Record<string, any>) => ({
      team: entry.team?.displayName,
      stats: Object.fromEntries((entry.stats ?? []).filter((s: Record<string, any>) => s.displayValue !== undefined).slice(0, 10).map((s: Record<string, any>) => [s.abbreviation ?? s.name, s.displayValue]))
    }))
  }))
}

/** The prompt tools' implementations, by name. */
function implementations(ctx: ToolContext, base: ToolSet): Record<string, Run> {
  const memory = (): MemoryFiles => {
    if (!ctx.dataDir) throw new Error('Memory is not set up in this run.')
    return new MemoryFiles(join(ctx.dataDir, 'memory'))
  }
  const need = (name: string): Tool => {
    const found = base[name]
    if (!found) throw new Error(`This run has no ${name} tool to do that with.`)
    return found
  }
  const widget = (title: string, body: string, note?: string) => {
    if (!ctx.dataDir) throw new Error('Widgets are not set up in this run.')
    return saveWidget(ctx.dataDir, title, body, note)
  }
  /** Places found by places_search this run, by place_id, so the map tools can be given just ids. */
  const places = new Map<string, Record<string, unknown>>()
  /** Servers found by search_mcp_registry this run, by id, for suggest_connectors. */
  const registry = new Map<string, Record<string, unknown>>()

  const display = (name: string): Run => async (input) => {
    let data = input
    // The map and list displays may be given place_id references from places_search.
    if ((name === 'places_map_display_v0' || name === 'places_list_display_v0') && !Array.isArray(input.places) && Array.isArray(input.locations)) {
      data = { ...input, places: input.locations }
    }
    if (Array.isArray(data.places)) {
      data = {
        ...data,
        places: (data.places as Array<Record<string, unknown>>).map((place) => {
          const known = typeof place?.place_id === 'string' ? places.get(place.place_id) : undefined
          return known ? { ...known, ...place } : place
        })
      }
    }
    const title = str(data.title) || str(data.summary_title) || name.replace(/_v\d+$/, '').replace(/_/g, ' ')
    return widget(title, displayBody(name, data), 'Shown to the user in the chat.')
  }

  const impl: Record<string, Run> = {
    bash_tool: (input) => callTool(need('Bash'), { command: input.command, description: input.description }),
    create_file: async (input) => {
      const path = str(input.path)
      if (existsSync(resolveInside(ctx.root, path))) throw new Error(`${path} already exists. Edit it with str_replace, or overwrite it with bash_tool.`)
      return callTool(need('Write'), { file_path: path, content: str(input.file_text) })
    },
    str_replace: (input) => callTool(need('Edit'), { file_path: input.path, old_string: input.old_str, new_string: str(input.new_str) }),
    view: async (input) => {
      const path = str(input.path) || '.'
      const abs = resolveInside(ctx.root, path)
      if (existsSync(abs) && statSync(abs).isDirectory()) return callTool(need('list_files'), { path, depth: 2 })
      const range = Array.isArray(input.view_range) ? (input.view_range as number[]) : null
      const offset = range?.[0] && range[0] > 0 ? range[0] : 1
      const limit = range && range[1] && range[1] > 0 ? range[1] - offset + 1 : undefined
      return callTool(need('Read'), { file_path: path, offset, ...(limit ? { limit } : {}) })
    },
    present_files: (input) => callTool(need('SendUserFile'), { files: input.filepaths }),
    web_fetch: (input, { abortSignal }) => webFetchText(str(input.url), abortSignal),
    web_search: (input, { abortSignal }) => webSearchResults(str(input.query), abortSignal),
    web_search_fast: (input, { abortSignal }) => webSearchResults(str(input.query), abortSignal),

    image_search: async (input, { abortSignal }) => {
      const query = str(input.query)
      const count = Math.min(Math.max(Number(input.max_results) || 4, 1), 12)
      const body = (await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${count}`, abortSignal)) as { results?: Array<Record<string, unknown>> }
      const images = (body.results ?? []).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        thumbnail: str(r.thumbnail),
        source: str(r.foreign_landing_url),
        license: [str(r.license).toUpperCase(), str(r.creator)].filter(Boolean).join(' · ')
      }))
      if (images.length === 0) return { images: [], note: 'No openly licensed images found. Try other words.' }
      return { ...widget(`Images: ${query}`, imageGallery(query, images)), images }
    },

    memory_read: async (input) => memory().read(input.path as string | string[]),
    memory_write: async (input) => memory().write(str(input.path), str(input.content), str(input.if_version)),
    memory_append: async (input) => memory().append(str(input.path), str(input.content), str(input.if_version)),
    memory_str_replace: async (input) => memory().replace(str(input.path), str(input.old_str), str(input.new_str), str(input.if_version)),
    memory_delete: async (input) => memory().delete(str(input.path), str(input.if_version)),
    memory_list: async (input) => memory().list(input.path_prefix as string | null, input.cursor as string | null, input.include_preview === true),

    conversation_search: async (input) => {
      if (!ctx.chats) throw new Error('Past chats are not available in this run.')
      const words = str(input.query).toLowerCase().split(/\s+/).filter((w) => w.length > 2)
      const max = Math.min(Number(input.max_results) || 5, 10)
      const chats = ctx.chats.list().filter((chat) => chat.id !== ctx.taskId && (!input.within_conversation_id || chat.id === input.within_conversation_id))
      const hits: Array<{ conversation_id: string; title: string; project: string; updated: string; excerpt: string; score: number }> = []
      for (const chat of chats) {
        const turns = ctx.chats.turns(chat.id)
        let best = { score: 0, excerpt: '' }
        for (const turn of turns) {
          const lower = turn.text.toLowerCase()
          const score = words.filter((w) => lower.includes(w)).length + words.filter((w) => chat.title.toLowerCase().includes(w)).length
          if (score > best.score) {
            const at = Math.max(0, lower.indexOf(words.find((w) => lower.includes(w)) ?? '') - 120)
            best = { score, excerpt: `${turn.role}: ${turn.text.slice(at, at + 400)}` }
          }
        }
        if (best.score > 0) hits.push({ conversation_id: chat.id, title: chat.title, project: chat.project, updated: new Date(chat.updatedAt).toISOString(), excerpt: best.excerpt, score: best.score })
      }
      hits.sort((a, b) => b.score - a.score)
      return hits.length ? hits.slice(0, max).map(({ score: _score, ...hit }) => hit) : 'No past chats match.'
    },
    recent_chats: async (input) => {
      if (!ctx.chats) throw new Error('Past chats are not available in this run.')
      const before = input.before ? Date.parse(str(input.before)) : Infinity
      const after = input.after ? Date.parse(str(input.after)) : -Infinity
      const n = Math.min(Number(input.n) || 3, 20)
      return ctx.chats
        .list()
        .filter((chat) => chat.id !== ctx.taskId && chat.updatedAt < before && chat.updatedAt > after)
        .slice(0, n)
        .map((chat) => {
          const turns = ctx.chats!.turns(chat.id)
          return { conversation_id: chat.id, title: chat.title, project: chat.project, updated: new Date(chat.updatedAt).toISOString(), first_message: turns[0]?.text.slice(0, 300) ?? '', last_reply: [...turns].reverse().find((t) => t.role === 'assistant')?.text.slice(0, 300) ?? '' }
        })
    },
    read_conversation: async (input) => {
      if (!ctx.chats) throw new Error('Past chats are not available in this run.')
      const id = str(input.conversation_id)
      const chat = ctx.chats.list().find((c) => c.id === id)
      if (!chat) throw new Error(`No chat with id ${id}. Use conversation_search or recent_chats for ids.`)
      const turns = ctx.chats.turns(id)
      const start = Number(input.page_token) || 0
      const max = Math.min(Number(input.max_turns) || 20, 50)
      const page = turns.slice(start, start + max)
      return { title: chat.title, project: chat.project, turns: page.map((t) => ({ role: t.role, text: t.text.slice(0, 4000) })), next_page_token: start + max < turns.length ? String(start + max) : null }
    },
    end_conversation: async () => ({ ended: true, note: 'The conversation is closed for this turn.' }),

    weather_fetch: async (input, { abortSignal }) => {
      const lat = Number(input.latitude)
      const lon = Number(input.longitude)
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`
      const body = (await getJson(url, abortSignal)) as Record<string, any>
      return { location: str(input.location_name), timezone: body.timezone, units: { ...body.current_units, ...body.daily_units }, current: body.current, daily: body.daily, weather_codes: 'WMO codes: 0 clear, 1-3 partly cloudy to overcast, 45/48 fog, 51-57 drizzle, 61-67 rain, 71-77 snow, 80-82 showers, 95-99 thunderstorm' }
    },
    places_search: async (input, { abortSignal }) => {
      const queries = Array.isArray(input.queries) ? (input.queries as Array<{ query?: string; max_results?: number }>) : [{ query: str(input.query) }]
      const lat = Number(input.location_bias_lat)
      const lng = Number(input.location_bias_lng)
      const radius = Number(input.location_bias_radius) || 5000
      const results: Array<{ query: string; places: unknown[] }> = []
      for (const [index, q] of queries.slice(0, 10).entries()) {
        if (index > 0) await delay(1100) // OpenStreetMap's search asks for at most one request a second.
        const limit = Math.min(Math.max(Number(q.max_results) || 5, 1), 10)
        let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(str(q.query))}&format=jsonv2&limit=${limit}&extratags=1`
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const d = radius / 111_000
          url += `&viewbox=${lng - d},${lat + d},${lng + d},${lat - d}`
        }
        const found = (await getJson(url, abortSignal)) as Array<Record<string, any>>
        results.push({
          query: str(q.query),
          places: found.map((p) => {
            const place = {
              place_id: `osm:${String(p.osm_type ?? 'n').charAt(0)}${p.osm_id}`,
              name: p.name || String(p.display_name ?? '').split(',')[0],
              address: p.display_name,
              latitude: Number(p.lat),
              longitude: Number(p.lon),
              category: [p.category, p.type].filter(Boolean).join(' / '),
              website: p.extratags?.website ?? p.extratags?.['contact:website'],
              opening_hours: p.extratags?.opening_hours,
              phone: p.extratags?.phone ?? p.extratags?.['contact:phone']
            }
            places.set(place.place_id, place)
            return place
          })
        })
      }
      return { source: 'OpenStreetMap', results }
    },
    fetch_sports_data: async (input, { abortSignal }) => {
      const league = str(input.league)
      const path = ESPN_LEAGUES[league]
      if (!path) throw new Error(`Live data for ${league} isn't available here. Search the web for it instead.`)
      const type = str(input.data_type)
      if (type === 'standings') return standings(await getJson(`https://site.api.espn.com/apis/v2/sports/${path}/standings`, abortSignal))
      if (type === 'game_stats') {
        if (!input.game_id) throw new Error('game_stats needs a game_id from a scores result.')
        const body = (await getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${encodeURIComponent(str(input.game_id))}`, abortSignal)) as Record<string, any>
        return { header: scoreboard({ events: [body.header] }, ''), boxscore: JSON.stringify(body.boxscore ?? {}).slice(0, 12_000) }
      }
      return scoreboard(await getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`, abortSignal), str(input.team))
    },

    search_mcp_registry: async (input, { abortSignal }) => {
      const keywords = (Array.isArray(input.keywords) ? input.keywords : [input.keywords]).map(str).filter(Boolean)
      const seen = new Map<string, Record<string, unknown>>()
      for (const keyword of keywords.slice(0, 5)) {
        const body = (await getJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(keyword)}&limit=10`, abortSignal)) as { servers?: Array<Record<string, any>> }
        for (const entry of body.servers ?? []) {
          const server = (entry.server ?? entry) as Record<string, any>
          const id = str(server.name)
          if (!id || seen.has(id)) continue
          const result = {
            uuid: id,
            name: id,
            description: server.description,
            remote_url: server.remotes?.[0]?.url,
            package: server.packages?.[0] ? `${server.packages[0].registryType ?? server.packages[0].registry_name ?? ''} ${server.packages[0].identifier ?? server.packages[0].name ?? ''}`.trim() : undefined
          }
          seen.set(id, result)
          registry.set(id, result)
        }
      }
      return seen.size ? [...seen.values()].slice(0, 15) : 'No MCP servers match in the public registry.'
    },
    suggest_connectors: async (input) => {
      const ids = (Array.isArray(input.uuids) ? input.uuids : []).map(str)
      const found = ids.map((id) => registry.get(id) ?? { uuid: id })
      return {
        shown: false,
        servers: found,
        note: 'Deskmates has no install card for connectors. Ask the user with ask_user_input_v0 whether to add one; on yes, add it with add_mcp_server (a remote_url as an HTTP server, a package with the command that runs it), then tell them it is in the Connectors list.'
      }
    },
    search_skills: async (input) => {
      const words = (Array.isArray(input.keywords) ? input.keywords : [input.keywords]).map((k) => str(k).toLowerCase()).filter(Boolean)
      const skills = ctx.skills?.list() ?? []
      const matches = skills.filter((s) => words.some((w) => s.name.toLowerCase().includes(w))).map((s) => ({ name: s.name, enabled: s.enabled }))
      return matches.length ? matches : { matches: [], note: 'No installed skill matches. install_skill can add one from a folder or a GitHub repo the user names.' }
    },
    search_plugins: async (input) => {
      const words = (Array.isArray(input.keywords) ? input.keywords : [input.keywords]).map((k) => str(k).toLowerCase()).filter(Boolean)
      const plugins = ctx.plugins?.list() ?? []
      const matches = plugins.filter((p) => words.some((w) => p.name.toLowerCase().includes(w))).map((p) => ({ name: p.name, source: p.source }))
      return matches.length ? matches : { matches: [], note: 'No installed plugin matches. install_plugin can add one from a folder or a GitHub repo the user names.' }
    },
    suggest_skills: async (input) => ({ shown: false, keywords: input.keywords, note: 'Deskmates has no install card for skills. Name the skill to the user and ask with ask_user_input_v0; on yes, install it with install_skill.' }),
    suggest_plugin_install: async (input) => ({ shown: false, plugins: input.plugins, note: 'Deskmates has no install card for plugins. Name the plugin to the user and ask with ask_user_input_v0; on yes, install it with install_plugin.' }),
    suggest_research: async (input) => ({ shown: false, note: `Deskmates has no research button. If deeper research would help (${str(input.rationale)}), say so in one sentence and do it when the user asks.` }),

    ask_user_input_v0: async (input) => ({
      shown: true,
      questions: Array.isArray(input.questions) ? input.questions.length : 0,
      note: 'The question card is on screen. End your turn now; the answers arrive as the next user message.'
    }),

    list_mcp_resources: async (input) => {
      if (!ctx.connectors) throw new Error('No connectors are set up.')
      return ctx.connectors.listResources(str(input.source))
    },
    read_resource_link: async (input) => {
      if (!ctx.connectors) throw new Error('No connectors are set up.')
      return ctx.connectors.readResource(str(input.source), str(input.uri))
    },

    mcp__visualize__read_me: async () =>
      [
        'Widgets you send with mcp__visualize__show_widget are drawn in the chat in a sandboxed frame that fits their height.',
        '- Send SVG (starting with <svg) or an HTML fragment; no <html>, <head> or <body> needed.',
        '- Scripts run after the widget loads. Libraries may come from https CDNs (cdnjs, jsdelivr, unpkg). Nothing is sent anywhere else.',
        '- Theme with these CSS variables so it matches light and dark mode: --card, --ink, --muted, --faint, --rule, --accent, --accent-soft, --good, --bad. The background is transparent.',
        '- Keep it compact (it sits in a chat column about 700px wide) and readable at 360px.',
        '- sendPrompt is not available; links open in the browser.'
      ].join('\n'),
    mcp__visualize__show_widget: async (input) => {
      const code = str(input.widget_code)
      const title = str(input.title) || 'Widget'
      return widget(title, /^\s*<svg/i.test(code) ? `<div class="card">${code}</div>` : code)
    },
    Artifact: async (input) => {
      const action = str(input.action) || 'publish'
      if (action !== 'publish') return { note: `Deskmates keeps artifacts as files in the project; "${action}" isn't needed here. Use present_files to show a file again.` }
      const path = str(input.file_path)
      if (!path) throw new Error('Artifact needs file_path: write the page to a file first, then publish it.')
      const abs = resolveInside(ctx.root, path)
      if (!existsSync(abs)) throw new Error(`${path} doesn't exist yet. Write it first.`)
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(abs, 'utf8')
      const title = str(input.title) || path
      const page = /\.md$/i.test(path) ? widgetPage(title, `<div class="card" style="white-space:pre-wrap">${content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</div>`) : content
      return { ...widget(title, page, `Shown in the chat. Deskmates has no claude.ai link; the page is the file ${path} in the project folder.`), file: path }
    }
  }
  for (const name of DISPLAY_TOOLS) impl[name] = display(name)
  return impl
}

/**
 * The prompt's tools for this run: every tool the prompt's "Tools" section describes that Deskmates
 * can do and that `base` doesn't already have under that name.
 */
export function promptTools(ctx: ToolContext, base: ToolSet): ToolSet {
  const specs = promptToolSpecs()
  if (specs.size === 0) return {}
  const impl = implementations(ctx, base)
  const out: ToolSet = {}
  for (const [name, run] of Object.entries(impl)) {
    const spec = specs.get(name)
    if (!spec || name in base) continue
    out[name] = tool({
      description: spec.description || `The ${name} tool from your operating prompt.`,
      inputSchema: (spec.schema ? jsonSchemaToZod(spec.schema) : z.looseObject({})) as z.ZodType<Input>,
      execute: async (input: Input, options: { abortSignal?: AbortSignal }) => run(input ?? {}, options)
    }) as Tool
  }
  return out
}
