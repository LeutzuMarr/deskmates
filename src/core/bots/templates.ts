/**
 * Bot templates: ready-made bot configurations a user can create from a few answers instead of
 * writing instructions from scratch (design spec 5.5's "bot templates," 5.8's setup-wizard step 4:
 * "It offers a first bot from a template: 'Daily website digest to WhatsApp'"). `createBotFromTemplate`
 * does the actual work — the bot, its PC row, its first schedule and its seed memory file, all in
 * one call — so a future `bots.createFromTemplate` RPC handler and the setup wizard's own backend
 * code can both share it instead of duplicating the wiring `handlers.ts`'s `bots.create` and
 * `schedules.create` already do separately. See this task's report for the RPC method this doesn't
 * add (`protocol.ts` isn't this file's to edit).
 */
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Bot, BotPc, CoreEvent, Schedule } from '../../shared/protocol'
import type { EventBus } from '../events'
import type { Repos } from '../store/repos'
import { pcStorageDir } from './host-paths'
import type { ScheduleService } from './services'

/** One field the wizard should collect from the user before calling `createBotFromTemplate` with this template. */
export interface TemplateField {
  key: string
  label: string
  description: string
  kind: 'text' | 'url' | 'time'
  required: boolean
  placeholder?: string
}

/** What a template's `build()` turns its params into — everything `createBotFromTemplate` needs to create the bot, its schedule and its seed memory. */
export interface BuiltBotSpec {
  name: string
  instructions: string
  /** The message sent to the bot as the first turn of every scheduled run (`Schedule.task`). */
  task: string
  /** Five-field cron, local time (see `scheduler/cron.ts`). */
  cron: string
  missed: 'run-late' | 'skip'
  /** Files to seed under the bot's own PC storage before its first run, keyed the same way `write_pc_file` takes paths (must start "data/"). */
  memory: Record<string, string>
  /**
   * Tools to pre-approve on the bot itself (`Bot.autoApprove`), so a scheduled run never stalls
   * waiting for someone to click approve at 8am with nobody watching (design spec 5.1: "a task or
   * schedule can pre-approve specific risky actions... so scheduled bots can run unattended";
   * 5.11's own example is exactly this one). `whatsapp_send` is in `RISKY_BOT_TOOLS`
   * (`tools/index.ts`) precisely because sending a message is a risky action by default — a
   * template built around sending one unattended needs to say so explicitly rather than silently
   * relying on the user to notice and approve it by hand later.
   */
  autoApprove: string[]
}

export interface BotTemplate<Params> {
  id: string
  name: string
  description: string
  /** Pre-filled default for the wizard's "time" field; the user picks the real one. */
  suggestedTime: string
  /** Tool names this template's bot is built around, for the UI to explain what it can do. Descriptive only — every bot gets the full `botTools()` set (see `tools/index.ts`); there is no per-bot allowlist. */
  tools: string[]
  fields: TemplateField[]
  build(params: Params): BuiltBotSpec
}

export interface DailyDigestParams {
  /** The site to check every day. "https://" is added automatically if missing, same as the `open_page` tool. */
  site: string
  /** 24-hour local time, "HH:MM". Defaults to the template's `suggestedTime` if left out. */
  time?: string
  /** What counts as worth reporting, folded into the bot's instructions. Defaults to "anything newly published today". */
  whatToReport?: string
  /** What to do about a run missed while the PC was off (design spec 5.7). Defaults to "run-late", matching `SchedulesRepo.create`'s own default. */
  missed?: 'run-late' | 'skip'
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "08:00" -> "0 8 * * *". Throws a plain message on anything not exactly 24-hour HH:MM. */
function cronForTime(time: string): string {
  const match = TIME_PATTERN.exec(time.trim())
  if (!match) throw new Error('Give the time as 24-hour HH:MM, e.g. "08:00".')
  const [, hh, mm] = match
  return `${Number(mm)} ${Number(hh)} * * *`
}

/** "https://example.com/news/" -> "example.com/news", for a short, readable bot name. Falls back to the raw input if it isn't URL-shaped. */
function siteLabel(site: string): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`)
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.hostname}${path}`
  } catch {
    return site
  }
}

function buildDailyDigestSpec(params: DailyDigestParams): BuiltBotSpec {
  const site = params.site.trim()
  if (!site) throw new Error('Give the site to check.')
  const cron = cronForTime(params.time?.trim() || DAILY_WEBSITE_DIGEST_TEMPLATE.suggestedTime)
  const missed = params.missed ?? 'run-late'
  const whatToReport = params.whatToReport?.trim()
  const whatCounts = whatToReport || 'anything newly published today — headlines, posts or announcements'

  const task = `Check ${site} for what's new today, then WhatsApp me a short summary — anything you haven't already reported.${
    whatToReport ? ` What counts as worth reporting: ${whatToReport}.` : ''
  }`

  const instructions = [
    "This bot checks one website every day and WhatsApps a short summary of what's new.",
    '',
    `Site to check: ${site}`,
    `What to report: ${whatCounts}.`,
    '',
    'Each run:',
    '1. Open the site and read it as text with read_page, not a screenshot — reading text uses far less of your budget than an image.',
    "2. Read data/reported.json with read_pc_file. It's a JSON array of short identifiers (a title or link is enough) for items you've already reported — empty on your very first run. If it's missing or unreadable, treat it as empty rather than stopping.",
    "3. Work out which of today's items are not already in that list.",
    '4. Send exactly one WhatsApp message with a short summary — a few lines, not the whole page. If nothing is new, say so in one line; never re-list anything already in data/reported.json.',
    "5. Update data/reported.json with write_pc_file so it includes everything you've now reported, keeping the earlier entries too — that's what stops tomorrow's run from repeating today's.",
    '',
    "Never log in anywhere for this, even if the site asks: don't type a username or password. If you can't see today's items without logging in, say that in your summary instead of trying, and ask the user to open Take Over and sign in themselves."
  ].join('\n')

  return {
    name: `Daily digest: ${siteLabel(site)}`.slice(0, 120),
    instructions,
    task,
    cron,
    missed,
    memory: { 'data/reported.json': '[]\n' },
    // Unattended by design (it only runs on a schedule) and WhatsApp delivery is the whole point,
    // so this is the one tool it needs pre-approved. It's still the *only* one: screen_* stays
    // gated, so a bot that unexpectedly needs raw desktop control still stops and asks.
    autoApprove: ['whatsapp_send']
  }
}

export const DAILY_WEBSITE_DIGEST_TEMPLATE: BotTemplate<DailyDigestParams> = {
  id: 'daily-website-digest',
  name: 'Daily website digest to WhatsApp',
  description: "Checks a site once a day, works out what's new since last time, and WhatsApps you a short summary.",
  suggestedTime: '08:00',
  tools: ['open_page', 'read_page', 'list_pc_files', 'read_pc_file', 'write_pc_file', 'whatsapp_send'],
  fields: [
    {
      key: 'site',
      label: 'Site to check',
      description: 'The page this bot reads every day.',
      kind: 'url',
      required: true,
      placeholder: 'https://example.com/news'
    },
    {
      key: 'time',
      label: 'Time',
      description: 'When to run, every day, in your local time.',
      kind: 'time',
      required: true,
      placeholder: '08:00'
    },
    {
      key: 'whatToReport',
      label: 'What to report',
      description: 'What counts as worth mentioning. Leave blank for "anything newly published today".',
      kind: 'text',
      required: false,
      placeholder: 'New articles and price changes'
    }
  ],
  build: buildDailyDigestSpec
}

/** Every template the wizard can offer. One entry today; the shape supports adding more without touching `createBotFromTemplate`. */
export const BOT_TEMPLATES: ReadonlyArray<BotTemplate<any>> = [DAILY_WEBSITE_DIGEST_TEMPLATE]

export interface CreateBotFromTemplateDeps {
  repos: Repos
  /** The app's data folder. The bot's seed memory is written to `<dataDir>/pcs/<botId>/` (see `host-paths.ts`'s `pcStorageDir`) — the same host folder a running PC bind-mounts as `/home/bot/data`, so its first run finds the file there with no container involved. */
  dataDir: string
  /** Computes the new schedule's next run and registers its wake timer. Left unset, the schedule is still created, just with `nextRunAt: null` until something syncs it later — the same fallback `handlers.ts`'s `schedules.create` already uses. */
  schedule?: ScheduleService
  /** Emits the same events `bots.create`/`schedules.create` would (`bot.updated`, `pc.updated`, `schedule.updated`), so a UI watching the bus stays in sync. Left unset, nothing is emitted. */
  bus?: EventBus
}

export interface CreateBotFromTemplateResult {
  bot: Bot
  pc: BotPc
  schedule: Schedule
  /** Plain-language notes the wizard should show, e.g. a WhatsApp number that still needs to be set. Never blocks creation — Settings can always be filled in afterwards. */
  warnings: string[]
}

/**
 * Creates a bot, its PC row, its first schedule and its seed memory from a template, in one call.
 * Mirrors `handlers.ts`'s `bots.create` (bot row + PC row) and `schedules.create` (schedule row +
 * sync) exactly, so a bot built this way is indistinguishable from one assembled by hand through
 * those two RPC calls — plus its memory file already exists on disk, so its very first scheduled
 * run has something to read instead of starting from a missing-file error.
 */
export async function createBotFromTemplate<Params>(
  deps: CreateBotFromTemplateDeps,
  template: BotTemplate<Params>,
  params: Params
): Promise<CreateBotFromTemplateResult> {
  const spec = template.build(params)

  let bot = deps.repos.bots.create(spec.name, spec.instructions)
  if (spec.autoApprove.length > 0) bot = deps.repos.bots.update(bot.id, { autoApprove: spec.autoApprove })
  const pc = deps.repos.botPcs.create(bot.id)

  const storageDir = pcStorageDir(deps.dataDir, bot.id)
  for (const [path, content] of Object.entries(spec.memory)) {
    if (!path.startsWith('data/')) throw new Error(`Template memory paths must start with "data/": "${path}"`)
    const dest = join(storageDir, path.slice('data/'.length))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content, 'utf8')
  }

  let schedule = deps.repos.schedules.create(bot.id, spec.cron, spec.task, spec.missed)
  if (deps.schedule) {
    const { nextRunAt } = await deps.schedule.sync(schedule)
    schedule = deps.repos.schedules.update(schedule.id, { nextRunAt })
  }

  const warnings: string[] = []
  if (!deps.repos.settings.get().whatsappTo.trim()) {
    warnings.push("No WhatsApp number is set in Settings yet — add one before this bot can send messages.")
  }

  if (deps.bus) {
    const events: CoreEvent[] = [
      { type: 'bot.updated', bot },
      { type: 'pc.updated', pc },
      { type: 'schedule.updated', schedule }
    ]
    for (const event of events) deps.bus.emit(event)
  }

  return { bot, pc, schedule, warnings }
}
