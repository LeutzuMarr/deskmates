/**
 * Tools that drive the user's own Google Chrome (their tabs, their sign-ins), named and shaped like
 * Claude in Chrome's: tabs_context, tabs_create, navigate, read_page, find, computer, form_input,
 * get_page_text, javascript_tool, read_console_messages, read_network_requests, browser_batch,
 * upload_image, resize_window, gif_creator and turn_answer_start (and tabs_close). The first result
 * of a run carries the Claude in Chrome instructions (prompts/claude-in-chrome), unless the agent
 * already read them with read_chrome_instructions.
 * Every agent gets them: the Work tab, the command-line agents through deskmates-prompt, bots, Duo.
 *
 * The same rules as the agent browser, applied here rather than left to the model:
 * - opening and reading a page an agent opened never asks; clicking, typing, filling and scripts on
 *   a site ask the user once per site (in the app, the agent browser's question card);
 * - the user's own tabs (ones no agent opened) are asked about before anything, reading included;
 * - anything that sends, posts, pays, signs or deletes asks first, every time;
 * - passwords, one-time codes, card and ID numbers are never typed, filled or scripted;
 * - LinkedIn: nothing presses Send or Connect, and it isn't used while the user is away;
 * - Chrome's own pages (chrome://settings and the like) are off limits.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { tool, type Tool, type ToolResultPart, type ToolSet } from 'ai'
import { z } from 'zod'
import { AWAY_AFTER_SECONDS, domainOf, isLinkedIn, isSendControl, isSensitiveField } from '../../shared/agent-browser'
import type { SiteAnswer, SiteAsk } from '../../shared/agent-browser'
import type { ChromeDriver, ChromeTab, MouseButton } from '../chrome/service'
import { modifierBits } from '../chrome/service'
import { decodePng, drawOverlays, encodeGif, type FrameAction, type GifOptions } from '../chrome/gif'
import { chromeInstructions, chromeInstructionsDue, markChromeInstructionsGiven } from '../engine/guides'
import {
  ENTER_TARGET_SCRIPT,
  fieldScript,
  findScript,
  FOCUSED_FIELD_SCRIPT,
  formInputScript,
  locateScript,
  pageTextScript,
  pointScript,
  readPageScript,
  scrollToScript
} from '../chrome/page-scripts'

const ASK_TIMEOUT_MS = 10 * 60_000

type ToolResultOutput = ToolResultPart['output']

/** The part of BrowserService the Chrome tools use to ask the user. */
export interface ChromeAsker {
  ask(input: { kind: SiteAsk['kind']; domain: string; detail: string; agent: string; runKey: string }, timeoutMs: number, signal?: AbortSignal): Promise<SiteAnswer | 'timeout'>
  isAllowed(domain: string, runKey: string): boolean
  idleSeconds(): number
}

export interface ChromeToolDeps {
  chrome: ChromeDriver
  asker: ChromeAsker
  /** Who is acting, as the user reads it: "Work", "Freebuff", a bot's name. */
  agent: string
  /** Keys "Allow once" answers and the current tab to this run. */
  runKey: string
  /** Duo only: the approved Outbox item that may be sent on `domain` right now. */
  sendPermit?: (domain: string) => { id: string; summary: string } | null
  /** Where screenshots are saved. */
  screenshotDir?: string
  /** Whether the model can be shown pictures. */
  withImages?: boolean
  /** Where exported GIFs are saved (the project folder); the screenshot folder when absent. */
  outputDir?: string
  /** Hand the Claude in Chrome instructions over with the first Chrome result of a run (default true). */
  handOverInstructions?: boolean
  signal?: AbortSignal
}

/** The Chrome tools' names, for the deskmates-prompt server's list. */
export const CHROME_TOOL_NAMES = [
  'tabs_context',
  'tabs_create',
  'tabs_close',
  'navigate',
  'read_page',
  'find',
  'computer',
  'form_input',
  'get_page_text',
  'javascript_tool',
  'read_console_messages',
  'read_network_requests',
  'browser_batch',
  'upload_image',
  'resize_window',
  'gif_creator',
  'turn_answer_start'
] as const

/** Tools whose result is a change on the page, so a GIF recording takes a frame after them. */
const FRAME_TOOLS: ReadonlySet<string> = new Set(['navigate', 'computer', 'form_input', 'tabs_create', 'upload_image'])
const MAX_FRAMES = 80

const tabId = z.number().int().positive().optional().describe('The tab to use, from tabs_context. Defaults to the tab used last.')
const ref = z.string().regex(/^ref_\d+$/, 'A ref looks like ref_12, from read_page or find.')
const point = z.array(z.number()).length(2)

const SCHEMAS = {
  tabs_context: z.object({
    createIfEmpty: z.boolean().default(false).describe('Open a new tab when no Deskmates tab is open yet'),
    includeUserTabs: z.boolean().default(false).describe("Also list the user's own tabs (titles and addresses). Using one asks the user first.")
  }),
  tabs_create: z.object({ url: z.string().optional().describe('An address to open in the new tab') }),
  tabs_close: z.object({ tabId: z.number().int().positive().describe('A tab a Deskmates agent opened') }),
  navigate: z.object({
    url: z.string().min(1).describe('The address to open, or "back" / "forward"'),
    tabId: tabId.describe('The tab to use. Without one, the tab used last, or a new tab.')
  }),
  read_page: z.object({
    tabId,
    filter: z.enum(['all', 'interactive']).default('all').describe("'interactive': only buttons, links and fields"),
    depth: z.number().int().min(1).max(50).default(15),
    ref_id: ref.optional().describe('Only this element and what is inside it'),
    max_chars: z.number().int().min(500).max(200_000).default(50_000)
  }),
  find: z.object({ query: z.string().min(1).describe('Words to look for in elements’ role, name or text, like "search box" or "Sign in"'), tabId }),
  computer: z.object({
    action: z.enum(['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'screenshot', 'scroll', 'wait', 'left_click_drag', 'zoom', 'scroll_to', 'hover']),
    tabId,
    coordinate: point.optional().describe('(x, y) in the last screenshot, for clicks, scroll, hover and the end of a drag'),
    ref: ref.optional().describe('An element from read_page/find, instead of coordinate'),
    text: z.string().optional().describe('The text to type, or the key(s) to press, space-separated ("Enter", "ctrl+a", "Backspace Backspace")'),
    modifiers: z.string().optional().describe('For clicks: "ctrl", "shift", "alt", "cmd", combined with +'),
    start_coordinate: point.optional().describe('Where a left_click_drag starts'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().int().min(1).max(10).optional().describe('Scroll wheel ticks, default 3'),
    region: z.array(z.number()).length(4).optional().describe('(x0, y0, x1, y1) to zoom into'),
    duration: z.number().min(0).max(10).optional().describe('Seconds to wait, at most 10'),
    repeat: z.number().int().min(1).max(100).optional().describe('How many times to press the key(s)')
  }),
  form_input: z.object({
    ref: ref.describe('The field, from read_page or find'),
    value: z.union([z.string(), z.number(), z.boolean()]).describe('Text for a field, an option for a list, true/false for a checkbox'),
    tabId
  }),
  get_page_text: z.object({ tabId, max_chars: z.number().int().min(500).max(200_000).default(50_000) }),
  javascript_tool: z.object({
    action: z.literal('javascript_exec').default('javascript_exec'),
    text: z.string().min(1).describe('JavaScript to run in the page. The value of the last expression is returned; top-level await works.'),
    tabId
  }),
  read_console_messages: z.object({
    tabId,
    onlyErrors: z.boolean().default(false),
    pattern: z.string().optional().describe('Only messages matching this regular expression'),
    limit: z.number().int().min(1).max(500).default(50),
    clear: z.boolean().default(false).describe('Forget the messages after reading them')
  }),
  read_network_requests: z.object({
    tabId,
    urlPattern: z.string().optional().describe('Only requests whose address contains this'),
    limit: z.number().int().min(1).max(500).default(50),
    requestId: z.string().optional().describe("Return this request's response body instead of the list"),
    clear: z.boolean().default(false).describe('Forget the requests after reading them')
  }),
  browser_batch: z.object({
    actions: z
      .array(
        z.object({
          name: z.string().min(1).describe('A Chrome tool name (computer, navigate, find, form_input, tabs_create…). browser_batch cannot be nested.'),
          input: z.record(z.string(), z.unknown()).default({}).describe("That tool's input, as you would pass it directly")
        })
      )
      .min(1)
      .max(30)
      .describe('Tool calls to run one after another; the batch stops at the first error')
  }),
  upload_image: z.object({
    imageId: z.string().min(1).describe('A screenshot\'s image id (from a computer screenshot, like "screenshot_3"), or the path of an image file in the project folder'),
    ref: ref.optional().describe('A file input (or the element holding one), from read_page or find'),
    coordinate: point.optional().describe('Where to drop the image, in the last screenshot (for drag-and-drop targets)'),
    tabId,
    filename: z.string().optional().describe('The file name the site sees (default image.png)')
  }),
  resize_window: z.object({
    width: z.number().int().min(200).max(7680).describe('Window width in pixels'),
    height: z.number().int().min(200).max(4320).describe('Window height in pixels'),
    tabId
  }),
  gif_creator: z.object({
    action: z.enum(['start_recording', 'stop_recording', 'export', 'clear']),
    tabId,
    coordinate: point.optional().describe("For export: drop the GIF on the page here instead of saving it (download)"),
    download: z.boolean().optional().describe('For export: save the GIF to the project folder'),
    filename: z.string().optional().describe('For export: the file name (default recording-<time>.gif)'),
    options: z
      .object({
        showClickIndicators: z.boolean().optional(),
        showDragPaths: z.boolean().optional(),
        showActionLabels: z.boolean().optional(),
        showProgressBar: z.boolean().optional(),
        showWatermark: z.boolean().optional(),
        quality: z.number().optional()
      })
      .optional()
  }),
  turn_answer_start: z.object({})
} satisfies Record<(typeof CHROME_TOOL_NAMES)[number], z.ZodObject>

const DESCRIPTIONS: Record<(typeof CHROME_TOOL_NAMES)[number], string> = {
  tabs_context:
    "The tabs Deskmates agents have open in the user's own Google Chrome (their real, signed-in browser), with their tab numbers. Call it first in a Chrome task. Set createIfEmpty to open a tab when there is none, includeUserTabs to also see the user's own tabs.",
  tabs_create: "Open a new tab in the user's Chrome, optionally at an address. Returns its tab number.",
  tabs_close: 'Close a tab a Deskmates agent opened in Chrome. The user’s own tabs are theirs to close.',
  navigate:
    'Open an address in a Chrome tab (or go "back" / "forward"). Without a tabId it uses the tab used last, or opens a new one. Chrome’s own pages (chrome://…) are off limits.',
  read_page:
    "Read a Chrome tab as an accessibility tree: each element's role and name, with a ref (ref_12) the other tools accept. filter 'interactive' lists only buttons, links and fields. Prefer this to screenshots for reading.",
  find: "Find elements in a Chrome tab whose role, name or text contains the query's words. Returns up to 20 lines with refs.",
  computer:
    "Mouse and keyboard in a Chrome tab: left_click, right_click, double_click, triple_click, hover (by coordinate from the last screenshot, or by ref), left_click_drag, scroll, scroll_to (ref), type, key, wait, screenshot, zoom (region). The first click or typing on a site asks the user. Anything that sends, posts, pays, signs or deletes needs the user's yes. Passwords and codes are never typed: the user types those in Chrome.",
  form_input: 'Set a field in a Chrome tab by ref: text fields, lists (by option text or value), checkboxes (true/false). Refuses password, code, card and ID fields.',
  get_page_text: "The visible text of a Chrome tab (the article or main part first), for reading long pages.",
  javascript_tool:
    'Run JavaScript in a Chrome tab and get the value of the last expression. The user is asked once per site before scripts run there. Never use it to fill passwords or codes, or to send, post, pay or delete.',
  read_console_messages: "Console messages and errors from a Chrome tab, since Deskmates started watching it (from the first tool call on that tab).",
  read_network_requests: "Network requests a Chrome tab made since Deskmates started watching it: method, address, status. Pass requestId to read one response's body.",
  browser_batch:
    'Run several Chrome tool calls in one go, in order (for example navigate, click a field, type, press Enter, screenshot). Each item is {name, input} with that tool\'s own input. Each call\'s own permission check still runs; the batch stops at the first error. Coordinates refer to the screenshot taken before the batch.',
  upload_image:
    "Upload a screenshot (its image id from computer's screenshot) or an image file from the project into a page: to a file input by ref, or dropped at a coordinate (drag-and-drop targets). Asks the user first, every time.",
  resize_window: "Resize the user's Chrome window (for checking a page at another size). Asks the user once per task.",
  gif_creator:
    'Record the Chrome session as an animated GIF: start_recording (then take a screenshot for the first frame), stop_recording (take a screenshot just before), export (download: true saves it to the project folder; coordinate drops it on the page), clear. Frames are taken after every action while recording; export draws click rings, drag paths, action labels and a progress bar.',
  turn_answer_start: 'Marks the start of your answer this turn. It does nothing in Deskmates; call it at most once, just before your answer.'
}

/** The Chrome tools as the deskmates-prompt server lists them. */
export function chromeToolInfos(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return CHROME_TOOL_NAMES.map((name) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(SCHEMAS[name], { io: 'input' }) as Record<string, unknown>
    return { name, description: DESCRIPTIONS[name], inputSchema: schema }
  })
}

/** Per-run memory that outlives one tool set (bridged calls build a fresh set for every call). */
interface RunMemory {
  lastTab?: number
  scriptsAllowed: Set<string>
  /** Recent screenshots: file → base64 JPEG. */
  shots: Map<string, string>
  /** Image ids handed out with screenshots ("screenshot_3") → their file. */
  shotIds: Map<string, string>
  shotCount: number
  /** What the last action did, for the GIF overlays. */
  lastAction?: FrameAction
  /** A GIF recording: PNG frames (base64) and what led to each. */
  gif?: { active: boolean; scale: number; frames: Array<{ png: string; action?: FrameAction }> }
}
const runs = new Map<string, RunMemory>()
function memory(runKey: string): RunMemory {
  let entry = runs.get(runKey)
  if (!entry) {
    entry = { scriptsAllowed: new Set(), shots: new Map(), shotIds: new Map(), shotCount: 0 }
    runs.set(runKey, entry)
    if (runs.size > 200) runs.delete(runs.keys().next().value as string)
  }
  return entry
}

/** Forgets a run's current tab and script answers (tests, and finished runs). */
export function forgetChromeRun(runKey: string): void {
  runs.delete(runKey)
}

/** The site a URL belongs to for permission questions; '' for blank pages. */
export function siteOf(url: string): string {
  if (/^file:/i.test(url)) return 'files on this PC'
  if (/^https?:/i.test(url)) return domainOf(url)
  return ''
}

/** Chrome's own pages and script addresses, which agents never open or touch. */
export function isOffLimits(url: string): boolean {
  return /^(chrome|chrome-untrusted|chrome-search|devtools|edge|brave|opera|vivaldi|about|javascript|data):/i.test(url.trim()) && !/^about:blank$/i.test(url.trim())
}

/** Script text that would fill a password or code field. */
export function scriptTouchesSecrets(code: string): boolean {
  const secret = /password|passwd|\bpass\b|one-time-code|\botp\b|\b2fa\b|totp|cvv|cvc|card.?number|cc-number|\biban\b/i
  const writes = /\.value\s*=(?!=)|setAttribute\(\s*['"]value|insertText|\.type\s*\(|dispatchEvent|\.click\s*\(/i
  return secret.test(code) && writes.test(code)
}

const LINKEDIN_AWAY =
  "LinkedIn isn't used while the user is away from the PC: its rules forbid automated use. Leave it for when the user is back."
const LINKEDIN_SEND = "On LinkedIn only the user presses Send or Connect. Fill it in, then tell the user it's ready in their Chrome."
const SECRET_FIELD = 'That is a password, code, card or ID field. Only the user types there: ask them to fill it in in their Chrome, then carry on.'

function shotText(tab: ChromeTab, shot: { width: number; height: number }, file: string | null, zoomed: boolean, imageId: string | null): string {
  const where = file ? ` Saved to ${file}${imageId ? ` (image id ${imageId}, for upload_image)` : ''}.` : ''
  return zoomed
    ? `Zoomed picture of part of tab ${tab.tabId} (${shot.width}×${shot.height}).${where} Coordinates for clicks still come from a full screenshot.`
    : `Screenshot of tab ${tab.tabId} (${tab.title || tab.url}), ${shot.width}×${shot.height}; clicks use these coordinates.${where}`
}

/** A one-line account of a Chrome call, for a GIF frame's label. */
function actionLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'computer') {
    const action = String(input.action ?? '')
    if (action === 'type') return `Type "${String(input.text ?? '').slice(0, 30)}"`
    if (action === 'key') return `Press ${String(input.text ?? '')}`
    if (action === 'scroll') return `Scroll ${String(input.scroll_direction ?? 'down')}`
    return action.replace(/_/g, ' ')
  }
  if (name === 'navigate') return `Go to ${String(input.url ?? '').replace(/^https?:\/\//, '').slice(0, 40)}`
  if (name === 'form_input') return `Fill ${String(input.ref ?? 'field')}`
  if (name === 'tabs_create') return 'New tab'
  if (name === 'upload_image') return 'Upload image'
  return name.replace(/_/g, ' ')
}

export function chromeTools(deps: ChromeToolDeps): ToolSet {
  const { chrome, asker, agent, runKey } = deps
  const mem = memory(runKey)

  const away = (): boolean => asker.idleSeconds() >= AWAY_AFTER_SECONDS

  /** The tab to act on: the one named, else the last used, else the first Deskmates tab. */
  const pickTab = async (id?: number): Promise<ChromeTab> => {
    if (id !== undefined) return chrome.tab(id)
    if (mem.lastTab !== undefined) {
      try {
        return await chrome.tab(mem.lastTab)
      } catch {
        mem.lastTab = undefined
      }
    }
    const { deskmates } = await chrome.tabs()
    if (deskmates[0]) return deskmates[0]
    throw new Error('No Chrome tab yet. Call tabs_context with createIfEmpty, tabs_create, or navigate to an address first.')
  }

  /** Site permission. Reading a tab an agent opened never asks; anything else asks once per site. */
  const ensureSite = async (tab: ChromeTab, level: 'read' | 'act'): Promise<void> => {
    if (isOffLimits(tab.url)) throw new Error(`Tab ${tab.tabId} shows one of Chrome's own pages (${tab.url}). Those are the user's; don't use them.`)
    if (isLinkedIn(tab.url) && away()) throw new Error(LINKEDIN_AWAY)
    if (level === 'read' && tab.deskmates) return
    const site = siteOf(tab.url)
    // A blank tab an agent opened has nothing to protect; a blank tab of the user's is still theirs.
    if (!site && tab.deskmates) return
    const domain = site || `tab ${tab.tabId}`
    if (asker.isAllowed(domain, runKey)) return
    const detail = tab.deskmates ? `use ${domain} in your Chrome` : `use your Chrome tab “${(tab.title || tab.url).slice(0, 80)}” (${domain})`
    const answer = await asker.ask({ kind: 'site', domain, detail, agent, runKey }, ASK_TIMEOUT_MS, deps.signal)
    if (answer === 'deny') throw new Error(`The user said no to using ${domain} in Chrome. Don't use it; tell them what you would have done there.`)
    if (answer === 'timeout') throw new Error(`The user hasn't answered whether you may use ${domain} in Chrome. Skip it for now and carry on with the rest.`)
  }

  /** A control that sends, posts, pays, signs or deletes: LinkedIn never, Duo with a permit, others ask. */
  const ensureSend = async (label: string, url: string): Promise<void> => {
    const domain = siteOf(url) || 'Chrome'
    if (isLinkedIn(url)) throw new Error(LINKEDIN_SEND)
    if (deps.sendPermit) {
      if (!deps.sendPermit(domain)) throw new Error(`“${label}” would send something on ${domain}, and nothing approved is waiting to be sent there. Put it in the Outbox for the user to approve first.`)
      return
    }
    const answer = await asker.ask({ kind: 'action', domain, detail: `click “${label}” on ${domain} in your Chrome`, agent, runKey }, ASK_TIMEOUT_MS, deps.signal)
    if (answer !== 'allow-once' && answer !== 'always') {
      throw new Error(answer === 'deny' ? `The user said no to “${label}”. Don't do it.` : `The user hasn't answered about “${label}”. Leave it undone and tell them.`)
    }
  }

  /** Before Enter: Ctrl/Cmd+Enter sends mail in most webmail; a plain Enter may submit through a Send button. */
  const guardEnter = async (tab: ChromeTab, chord: string): Promise<void> => {
    if (isLinkedIn(tab.url)) throw new Error(LINKEDIN_SEND)
    if (/(ctrl|control|cmd|meta)\s*\+\s*(enter|return)$/i.test(chord)) return ensureSend(chord, tab.url)
    const target = await chrome.evaluate<string | null>(tab.tabId, ENTER_TARGET_SCRIPT).catch(() => null)
    if (target && isSendControl(target)) await ensureSend(target, tab.url)
  }

  const refuseSecretFocus = async (tab: ChromeTab): Promise<void> => {
    const field = await chrome.evaluate<Parameters<typeof isSensitiveField>[0] | null>(tab.tabId, FOCUSED_FIELD_SCRIPT).catch(() => null)
    if (field && isSensitiveField(field)) throw new Error(SECRET_FIELD)
  }

  const used = (tab: ChromeTab): ChromeTab => {
    mem.lastTab = tab.tabId
    return tab
  }

  const describeTab = (tab: ChromeTab): string => `Tab ${tab.tabId}: ${tab.title || '(no title)'} | ${tab.url}`

  const saveShot = (data: string): { file: string; id: string } | null => {
    if (!deps.screenshotDir) return null
    mkdirSync(deps.screenshotDir, { recursive: true })
    const file = join(deps.screenshotDir, `chrome-${Date.now()}.jpg`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    mem.shots.set(file, data)
    while (mem.shots.size > 4) mem.shots.delete(mem.shots.keys().next().value as string)
    const id = `screenshot_${++mem.shotCount}`
    mem.shotIds.set(id, file)
    while (mem.shotIds.size > 30) mem.shotIds.delete(mem.shotIds.keys().next().value as string)
    return { file, id }
  }

  /** While recording a GIF: a frame of the tab as it is now, with what just happened. */
  const captureFrame = async (action?: FrameAction): Promise<void> => {
    const gif = mem.gif
    if (!gif?.active || mem.lastTab === undefined) return
    if (gif.frames.length >= MAX_FRAMES) {
      gif.active = false
      return
    }
    try {
      const shot = await chrome.screenshot(mem.lastTab, undefined, gif.scale, 'png')
      const scaled = (p?: [number, number]): [number, number] | undefined => (p ? [p[0] * gif.scale, p[1] * gif.scale] : undefined)
      gif.frames.push({ png: shot.data, ...(action ? { action: { label: action.label, ...(action.point ? { point: scaled(action.point)! } : {}), ...(action.from ? { from: scaled(action.from)! } : {}), ...(action.to ? { to: scaled(action.to)! } : {}) } } : {}) })
    } catch {
      // A frame that can't be taken (the tab closed, Chrome busy) is skipped.
    }
  }

  /** An image the agent names for upload: a screenshot id, or an image file in the project. */
  const imageFile = (imageId: string): string => {
    const known = mem.shotIds.get(imageId)
    if (known && existsSync(known)) return known
    const base = deps.outputDir ?? deps.screenshotDir
    const candidate = isAbsolute(imageId) ? imageId : base ? resolve(base, imageId) : ''
    const inside = base && candidate && (resolve(candidate).toLowerCase().startsWith(resolve(base).toLowerCase()) || (deps.screenshotDir && resolve(candidate).toLowerCase().startsWith(resolve(deps.screenshotDir).toLowerCase())))
    if (inside && existsSync(candidate) && statSync(candidate).isFile() && /\.(png|jpe?g|gif|webp|bmp)$/i.test(candidate)) return candidate
    throw new Error(`There is no image "${imageId}". Use the image id a screenshot gave (like screenshot_2), or the path of an image file in the project folder.`)
  }

  /** Asks before something leaves the PC for a site (an upload). Every time. */
  const ensureUpload = async (what: string, url: string): Promise<void> => {
    const domain = siteOf(url) || 'Chrome'
    if (isLinkedIn(url)) throw new Error(LINKEDIN_SEND)
    const answer = await asker.ask({ kind: 'action', domain, detail: `upload ${what} to ${domain} in your Chrome`, agent, runKey }, ASK_TIMEOUT_MS, deps.signal)
    if (answer !== 'allow-once' && answer !== 'always') throw new Error(answer === 'deny' ? `The user said no to uploading ${what}. Don't.` : `The user hasn't answered about uploading ${what}. Leave it undone and tell them.`)
  }

  const withShot = ({ output }: { output: unknown }): ToolResultOutput => {
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    const file = [...mem.shots.keys()].find((path) => text.includes(path))
    if (!deps.withImages || !file) return { type: 'text', value: text }
    return { type: 'content', value: [{ type: 'text', text }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: mem.shots.get(file)! } }] }
  }

  /** Each tool's input parsing and work, by name: what the tools run, and what browser_batch calls. */
  const runners = new Map<string, (raw: unknown) => Promise<string>>()

  /** The instructions, handed over once per run with the first Chrome result (unless already read). */
  const withInstructions = (name: string, result: string): string => {
    if (deps.handOverInstructions === false || name === 'turn_answer_start' || !chromeInstructionsDue(runKey)) return result
    const guide = chromeInstructions()
    if (!guide) return result
    markChromeInstructionsGiven(runKey)
    return `${result}\n\n---\nBefore your next Chrome step: these are the instructions for working in the user's Chrome. You get them once per task; follow them from here on.\n\n${guide}`
  }

  /** Builds a tool whose input is parsed here too, so bridged calls (which skip the SDK's parse) get defaults. */
  const make = <N extends (typeof CHROME_TOOL_NAMES)[number]>(name: N, run: (input: z.output<(typeof SCHEMAS)[N]>) => Promise<string>, extra: Record<string, unknown> = {}): Tool => {
    const runner = async (raw: unknown): Promise<string> => {
      const input = (SCHEMAS[name] as z.ZodType).parse(raw ?? {}) as z.output<(typeof SCHEMAS)[N]>
      mem.lastAction = undefined
      const result = await run(input)
      if (FRAME_TOOLS.has(name)) {
        const action = input as Record<string, unknown>
        const skip = name === 'computer' && (action.action === 'zoom' || action.action === 'wait')
        if (!skip) await captureFrame({ label: actionLabel(name, action), ...(mem.lastAction ?? {}) })
      }
      return result
    }
    runners.set(name, runner)
    return tool({
      description: DESCRIPTIONS[name],
      inputSchema: SCHEMAS[name] as z.ZodType,
      execute: async (raw: unknown) => withInstructions(name, await runner(raw)),
      ...extra
    } as unknown as Tool) as Tool
  }

  /** Where an element or coordinate is, and what a click there would press. */
  const target = async (tab: ChromeTab, input: { ref?: string; coordinate?: number[] }): Promise<{ x: number; y: number; name: string; url: string }> => {
    if (input.ref) {
      const spot = await chrome.evaluate<{ error?: string; x: number; y: number; name: string; url: string }>(tab.tabId, locateScript(input.ref))
      if (spot.error) throw new Error(spot.error)
      return { ...spot, url: spot.url || tab.url }
    }
    if (!input.coordinate) throw new Error('Give a coordinate from the last screenshot, or a ref from read_page/find.')
    const [x, y] = input.coordinate as [number, number]
    const under = await chrome.evaluate<{ name: string; url: string }>(tab.tabId, pointScript(x, y)).catch(() => ({ name: '', url: tab.url }))
    return { x, y, name: under.name, url: under.url || tab.url }
  }

  return {
    tabs_context: make('tabs_context', async ({ createIfEmpty, includeUserTabs }) => {
      let { deskmates, user } = await chrome.tabs()
      if (deskmates.length === 0 && createIfEmpty) {
        deskmates = [used(await chrome.createTab())]
      }
      const lines = deskmates.length > 0 ? ['Deskmates tabs in Chrome:', ...deskmates.map((t) => `${t.tabId === mem.lastTab ? '*' : ' '} ${describeTab(t)}`)] : ['No Deskmates tabs are open in Chrome yet (tabs_create or navigate opens one).']
      if (includeUserTabs) {
        lines.push('', "The user's own tabs (using one asks the user first):", ...(user.length > 0 ? user.map((t) => `  ${describeTab(t)}`) : ['  (none)']))
      } else if (user.length > 0) {
        lines.push('', `The user also has ${user.length} tab${user.length === 1 ? '' : 's'} of their own open (includeUserTabs lists them).`)
      }
      return lines.join('\n')
    }),

    tabs_create: make('tabs_create', async ({ url }) => {
      if (url && isOffLimits(url)) throw new Error("Chrome's own pages (chrome://…) and script addresses are off limits.")
      const full = url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? `https://${url}` : url
      if (full && isLinkedIn(full) && away()) throw new Error(LINKEDIN_AWAY)
      const tab = used(await chrome.createTab(full))
      return `Opened ${describeTab(tab)}`
    }),

    tabs_close: make('tabs_close', async ({ tabId: id }) => {
      const tab = await chrome.tab(id)
      if (!tab.deskmates) throw new Error(`Tab ${id} is one of the user's own tabs. Only the user closes those.`)
      await chrome.closeTab(id)
      if (mem.lastTab === id) mem.lastTab = undefined
      return `Closed tab ${id}.`
    }),

    navigate: make('navigate', async ({ url, tabId: id }) => {
      const where = url.trim()
      if (where === 'back' || where === 'forward') {
        const tab = used(await pickTab(id))
        await ensureSite(tab, 'read')
        return `Went ${where}. ${describeTab(await chrome.history(tab.tabId, where))}`
      }
      if (isOffLimits(where)) throw new Error("Chrome's own pages (chrome://…) and script addresses are off limits.")
      const full = /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`
      if (isLinkedIn(full) && away()) throw new Error(LINKEDIN_AWAY)
      let tab: ChromeTab
      try {
        tab = await pickTab(id)
      } catch (error) {
        if (id !== undefined) throw error
        return `Opened ${describeTab(used(await chrome.createTab(full)))}`
      }
      // Navigating away from the user's own tab replaces what they had there: ask.
      if (!tab.deskmates) await ensureSite(tab, 'act')
      return `Opened ${describeTab(used(await chrome.navigate(tab.tabId, full)))}`
    }),

    read_page: make('read_page', async ({ tabId: id, filter, depth, ref_id, max_chars }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      const page = await chrome.evaluate<{ error?: string; url: string; title: string; tree: string; truncated: boolean }>(
        tab.tabId,
        readPageScript({ filter, depth, ...(ref_id ? { refId: ref_id } : {}), maxChars: max_chars })
      )
      if (page.error) throw new Error(page.error)
      return [`Tab ${tab.tabId}: ${page.title || '(no title)'} | ${page.url}`, page.tree || '(nothing readable)', page.truncated ? `(Cut at ${max_chars} characters: use ref_id, a smaller depth or filter "interactive".)` : ''].filter(Boolean).join('\n')
    }),

    find: make('find', async ({ query, tabId: id }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      const found = await chrome.evaluate<{ matches: string[]; total: number }>(tab.tabId, findScript(query))
      if (found.matches.length === 0) return `Nothing in tab ${tab.tabId} matches "${query}". Try other words, or read_page.`
      return [`${found.total} match${found.total === 1 ? '' : 'es'} in tab ${tab.tabId}${found.total > found.matches.length ? ` (first ${found.matches.length})` : ''}:`, ...found.matches.map((m) => `- ${m}`)].join('\n')
    }),

    computer: make(
      'computer',
      async (input) => {
        const tab = used(await pickTab(input.tabId))
        const { action } = input
        switch (action) {
          case 'screenshot':
          case 'zoom': {
            await ensureSite(tab, 'read')
            if (action === 'zoom' && !input.region) throw new Error('zoom needs a region: (x0, y0, x1, y1) from a screenshot.')
            const shot = await chrome.screenshot(tab.tabId, action === 'zoom' ? (input.region as [number, number, number, number]) : undefined)
            const saved = saveShot(shot.data)
            return shotText(tab, shot, saved?.file ?? null, action === 'zoom', saved?.id ?? null)
          }
          case 'wait': {
            await new Promise((resolve) => setTimeout(resolve, Math.min(10, input.duration ?? 1) * 1000))
            return `Waited ${input.duration ?? 1}s. ${describeTab(await chrome.tab(tab.tabId))}`
          }
          case 'scroll': {
            await ensureSite(tab, 'read')
            const [x, y] = (input.coordinate as [number, number] | undefined) ?? [400, 300]
            const ticks = (input.scroll_amount ?? 3) * 100
            const dir = input.scroll_direction ?? 'down'
            await chrome.wheel(tab.tabId, x, y, dir === 'left' ? -ticks : dir === 'right' ? ticks : 0, dir === 'up' ? -ticks : dir === 'down' ? ticks : 0)
            return `Scrolled ${dir} in tab ${tab.tabId}.`
          }
          case 'scroll_to': {
            await ensureSite(tab, 'read')
            if (!input.ref) throw new Error('scroll_to needs a ref from read_page or find.')
            const done = await chrome.evaluate<{ error?: string }>(tab.tabId, scrollToScript(input.ref))
            if (done.error) throw new Error(done.error)
            return `Scrolled ${input.ref} into view.`
          }
          case 'hover': {
            await ensureSite(tab, 'read')
            const spot = await target(tab, input)
            await chrome.move(tab.tabId, spot.x, spot.y)
            mem.lastAction = { label: 'Hover', point: [spot.x, spot.y] }
            return `Hovering over ${spot.name ? `“${spot.name}”` : `(${Math.round(spot.x)}, ${Math.round(spot.y)})`}.`
          }
          case 'left_click':
          case 'right_click':
          case 'double_click':
          case 'triple_click': {
            await ensureSite(tab, 'act')
            const spot = await target(tab, input)
            if (isLinkedIn(spot.url) && away()) throw new Error(LINKEDIN_AWAY)
            if (spot.name && isSendControl(spot.name)) await ensureSend(spot.name, spot.url)
            const button: MouseButton = action === 'right_click' ? 'right' : 'left'
            const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1
            await chrome.click(tab.tabId, spot.x, spot.y, { button, count, modifiers: modifierBits(input.modifiers) })
            mem.lastAction = { label: spot.name ? `Click "${spot.name.slice(0, 30)}"` : 'Click', point: [spot.x, spot.y] }
            return `Clicked ${spot.name ? `“${spot.name}”` : `at (${Math.round(spot.x)}, ${Math.round(spot.y)})`} in tab ${tab.tabId}.`
          }
          case 'left_click_drag': {
            await ensureSite(tab, 'act')
            if (!input.start_coordinate || !input.coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate.')
            await chrome.drag(tab.tabId, input.start_coordinate as [number, number], input.coordinate as [number, number])
            mem.lastAction = { label: 'Drag', from: input.start_coordinate as [number, number], to: input.coordinate as [number, number] }
            return `Dragged from (${input.start_coordinate.join(', ')}) to (${input.coordinate.join(', ')}).`
          }
          case 'type': {
            await ensureSite(tab, 'act')
            if (input.text === undefined) throw new Error('type needs text.')
            await refuseSecretFocus(tab)
            await chrome.insertText(tab.tabId, input.text)
            return `Typed ${input.text.length} character${input.text.length === 1 ? '' : 's'} in tab ${tab.tabId}.`
          }
          case 'key': {
            await ensureSite(tab, 'act')
            if (!input.text?.trim()) throw new Error('key needs the key(s) to press, like "Enter" or "ctrl+a".')
            const chords = input.text.trim().split(/\s+/)
            const repeat = input.repeat ?? 1
            for (let i = 0; i < repeat; i++) {
              for (const chord of chords) {
                if (/(^|\+)(enter|return)$/i.test(chord)) await guardEnter(tab, chord)
                await chrome.key(tab.tabId, chord)
              }
            }
            return `Pressed ${input.text}${repeat > 1 ? ` ×${repeat}` : ''} in tab ${tab.tabId}.`
          }
        }
      },
      { toModelOutput: withShot }
    ),

    form_input: make('form_input', async ({ ref: element, value, tabId: id }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'act')
      const info = await chrome.evaluate<{ error?: string; field: Parameters<typeof isSensitiveField>[0]; name: string; role: string }>(tab.tabId, fieldScript(element))
      if (info.error) throw new Error(info.error)
      if (isSensitiveField(info.field)) throw new Error(SECRET_FIELD)
      const result = await chrome.evaluate<{ error?: string; set?: string }>(tab.tabId, formInputScript(element, value))
      if (result.error) throw new Error(result.error)
      return `Set ${info.role}${info.name ? ` “${info.name}”` : ''} (${element}) to ${JSON.stringify(result.set ?? value)}.`
    }),

    get_page_text: make('get_page_text', async ({ tabId: id, max_chars }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      const page = await chrome.evaluate<{ url: string; title: string; text: string; truncated: boolean }>(tab.tabId, pageTextScript(max_chars))
      return [`Tab ${tab.tabId}: ${page.title || '(no title)'} | ${page.url}`, '', page.text || '(no text)', page.truncated ? `\n(Cut at ${max_chars} characters.)` : ''].join('\n')
    }),

    javascript_tool: make('javascript_tool', async ({ text, tabId: id }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'act')
      if (scriptTouchesSecrets(text)) throw new Error('Scripts may not fill or submit passwords, codes, card or ID numbers. Only the user enters those, in their Chrome.')
      if (isLinkedIn(tab.url)) throw new Error("Scripts don't run on LinkedIn: its rules forbid automated use. Read it with read_page instead.")
      const site = siteOf(tab.url) || `tab ${tab.tabId}`
      if (!mem.scriptsAllowed.has(site) && !deps.sendPermit) {
        const snippet = text.replace(/\s+/g, ' ').slice(0, 140)
        const answer = await asker.ask({ kind: 'action', domain: site, detail: `run a script on ${site} in your Chrome (${snippet})`, agent, runKey }, ASK_TIMEOUT_MS, deps.signal)
        if (answer !== 'allow-once' && answer !== 'always') throw new Error(answer === 'deny' ? `The user said no to scripts on ${site}. Use read_page, find and computer instead.` : `The user hasn't answered about scripts on ${site}. Use read_page, find and computer instead.`)
        mem.scriptsAllowed.add(site)
      }
      const value = await chrome.evaluate(tab.tabId, text)
      const shown = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return shown.length > 50_000 ? `${shown.slice(0, 50_000)}\n…(cut)` : shown
    }),

    read_console_messages: make('read_console_messages', async ({ tabId: id, onlyErrors, pattern, limit, clear }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      let matcher: RegExp | null = null
      if (pattern) {
        try {
          matcher = new RegExp(pattern, 'i')
        } catch {
          throw new Error(`"${pattern}" isn't a valid regular expression.`)
        }
      }
      await chrome.watch?.(tab.tabId)
      const all = chrome.consoleMessages(tab.tabId).filter((m) => (!onlyErrors || m.level === 'error') && (!matcher || matcher.test(m.text)))
      if (clear) chrome.clearConsole(tab.tabId)
      if (all.length === 0) return `No console messages${onlyErrors ? ' (errors)' : ''} in tab ${tab.tabId} since Deskmates started watching it.`
      return all
        .slice(-limit)
        .map((m) => `[${m.level}] ${m.text}${m.url ? `  (${m.url})` : ''}`)
        .join('\n')
    }),

    read_network_requests: make('read_network_requests', async ({ tabId: id, urlPattern, limit, requestId, clear }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      await chrome.watch?.(tab.tabId)
      if (requestId) {
        const body = await chrome.responseBody(tab.tabId, requestId)
        return body.length > 50_000 ? `${body.slice(0, 50_000)}\n…(cut)` : body
      }
      const all = chrome.networkRequests(tab.tabId).filter((r) => !urlPattern || r.url.includes(urlPattern))
      if (clear) chrome.clearNetwork(tab.tabId)
      if (all.length === 0) return `No network requests${urlPattern ? ` matching "${urlPattern}"` : ''} in tab ${tab.tabId} since Deskmates started watching it.`
      return all
        .slice(-limit)
        .map((r) => `${r.requestId}  ${r.method} ${r.status ?? (r.failed ? 'FAILED' : '…')} ${r.url.length > 200 ? `${r.url.slice(0, 199)}…` : r.url}${r.type ? `  [${r.type}]` : ''}${r.failed ? `  ${r.failed}` : ''}`)
        .join('\n')
    }),

    browser_batch: make(
      'browser_batch',
      async ({ actions }) => {
        const lines: string[] = []
        for (const [index, item] of actions.entries()) {
          if (item.name === 'browser_batch') throw new Error('browser_batch cannot be nested.')
          const runner = runners.get(item.name)
          if (!runner) {
            lines.push(`${index + 1}. ${item.name}: there is no Chrome tool by that name. Stopped here.`)
            break
          }
          try {
            lines.push(`${index + 1}. ${item.name}: ${await runner(item.input)}`)
          } catch (error) {
            lines.push(`${index + 1}. ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`, `Stopped after ${index} of ${actions.length} steps.`)
            break
          }
        }
        return lines.join('\n')
      },
      { toModelOutput: withShot }
    ),

    upload_image: make('upload_image', async ({ imageId, ref: element, coordinate, tabId: id, filename }) => {
      if (!element === !coordinate) throw new Error('Give either ref (a file input) or coordinate (a drop target), not both.')
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'act')
      let file = imageFile(imageId)
      if (filename && basename(file) !== filename) {
        const dir = deps.screenshotDir ?? deps.outputDir
        if (dir && /^[\w .()-]+\.(png|jpe?g|gif|webp)$/i.test(filename)) {
          mkdirSync(dir, { recursive: true })
          const copy = join(dir, filename)
          writeFileSync(copy, readFileSync(file))
          file = copy
        }
      }
      await ensureUpload(`the image ${basename(file)}`, tab.url)
      if (element) {
        if (!chrome.setFiles) throw new Error("This Chrome connection can't fill file inputs.")
        await chrome.setFiles(tab.tabId, element, [file])
        return `Put ${basename(file)} in the file input ${element} in tab ${tab.tabId}.`
      }
      if (!chrome.dropFiles) throw new Error("This Chrome connection can't drop files on a page.")
      const [x, y] = coordinate as [number, number]
      await chrome.dropFiles(tab.tabId, x, y, [file])
      mem.lastAction = { label: 'Upload image', point: [x, y] }
      return `Dropped ${basename(file)} at (${x}, ${y}) in tab ${tab.tabId}.`
    }),

    resize_window: make('resize_window', async ({ width, height, tabId: id }) => {
      const tab = used(await pickTab(id))
      await ensureSite(tab, 'read')
      if (!chrome.resizeWindow) throw new Error("This Chrome connection can't resize windows.")
      if (!mem.scriptsAllowed.has('resize-window')) {
        const answer = await asker.ask({ kind: 'action', domain: 'Chrome', detail: `resize your Chrome window to ${width}×${height}`, agent, runKey }, ASK_TIMEOUT_MS, deps.signal)
        if (answer !== 'allow-once' && answer !== 'always') throw new Error(answer === 'deny' ? "The user said no to resizing their Chrome window. Don't." : "The user hasn't answered about resizing their Chrome window. Leave it as it is.")
        mem.scriptsAllowed.add('resize-window')
      }
      await chrome.resizeWindow(tab.tabId, width, height)
      return `Resized the Chrome window to ${width}×${height}. Take a screenshot to see the page at that size.`
    }),

    gif_creator: make('gif_creator', async ({ action, tabId: id, coordinate, download, filename, options }) => {
      if (id !== undefined) used(await pickTab(id))
      switch (action) {
        case 'start_recording':
          mem.gif = { active: true, scale: 0.5, frames: mem.gif?.frames ?? [] }
          return 'Recording. Take a screenshot now so the first frame shows where you start; every action from here adds a frame.'
        case 'stop_recording': {
          if (!mem.gif) return 'Nothing is being recorded.'
          mem.gif.active = false
          return `Stopped recording with ${mem.gif.frames.length} frame${mem.gif.frames.length === 1 ? '' : 's'}. Export it with action "export".`
        }
        case 'clear':
          mem.gif = undefined
          return 'Cleared the recording.'
        case 'export': {
          const frames = mem.gif?.frames ?? []
          if (frames.length === 0) throw new Error('There are no frames: start_recording, act in the tab, then export.')
          if (!download && !coordinate) throw new Error('export needs download: true (save it to the project folder) or a coordinate to drop it on the page.')
          const gifOptions: GifOptions = { ...options, delayCs: 90 }
          const images = frames.map((frame, index) => {
            const image = decodePng(Buffer.from(frame.png, 'base64'))
            drawOverlays(image, frame.action, index, frames.length, gifOptions)
            return image
          })
          const gif = encodeGif(images, gifOptions)
          const dir = download ? (deps.outputDir ?? deps.screenshotDir) : (deps.screenshotDir ?? deps.outputDir)
          if (!dir) throw new Error('There is no folder to save the GIF in.')
          const name = filename && /^[\w .()-]+\.gif$/i.test(filename) ? filename : `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.gif`
          mkdirSync(dir, { recursive: true })
          const file = join(dir, name)
          writeFileSync(file, gif)
          const size = `${frames.length} frames, ${Math.round(gif.length / 1024)} KB`
          if (download) return `Saved the GIF to ${file} (${size}). Show it to the user with SendUserFile.`
          const tab = used(await pickTab(id))
          await ensureSite(tab, 'act')
          await ensureUpload(`the recording ${name}`, tab.url)
          if (!chrome.dropFiles) throw new Error("This Chrome connection can't drop files on a page.")
          const [x, y] = coordinate as [number, number]
          await chrome.dropFiles(tab.tabId, x, y, [file])
          return `Dropped the GIF (${size}) at (${x}, ${y}) in tab ${tab.tabId}. It is also saved at ${file}.`
        }
      }
    }),

    turn_answer_start: make('turn_answer_start', async () => 'OK. Write your answer now.')
  }
}
