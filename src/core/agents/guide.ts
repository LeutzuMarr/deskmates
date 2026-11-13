import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface AgentGuideInput {
  /** The app's data folder, e.g. D:\DeskmatesData. */
  dataDir: string
  /** Absolute path of the deskmates command, e.g. <dataDir>\agent-kit\deskmates.cmd on Windows. */
  commandPath: string
  appVersion: string
  pcs: { installed: false } | { installed: true; mode: 'own' | 'shared'; sharedFolder: string }
  /** Absolute path of the mounted claude-code operating prompt; added as a guide section when set. */
  operatingPromptPath?: string
}

export interface AgentGuide {
  markdown: string
  version: string
  phrase: string
  path: string
}

/** The folder holding the guide, the deskmates command and bridge.json. */
export function agentKitDir(dataDir: string): string {
  return join(dataDir, 'agent-kit')
}

/**
 * The `deskmates` command connected coding agents run to reach the app from their own shell.
 *
 * Windows gets a `.cmd` batch file because that's what the shell will execute; Linux and macOS get an
 * extensionless script with a shebang instead, since `.cmd` is meaningless there. Both the main
 * process (which writes the file) and the core (which points agents at it in the guide) resolve it
 * through this function, so they can't disagree about the name.
 */
export function agentCommandFileName(): string {
  return process.platform === 'win32' ? 'deskmates.cmd' : 'deskmates'
}

/** How the guide names the host OS, so it never tells an agent the wrong platform. */
function hostOs(): string {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  return 'Linux'
}

/** The 32 short words the check phrase draws from. */
export const PHRASE_WORDS = [
  'MATE', 'KETTLE', 'CEDAR', 'EMBER', 'RIVER', 'GOURD', 'STRAW', 'LEAF',
  'COPPER', 'HARBOR', 'MAPLE', 'FERN', 'SLATE', 'CLAY', 'OAT', 'IVORY',
  'LANTERN', 'MEADOW', 'PEBBLE', 'QUILL', 'RAVEN', 'SAGE', 'TIDE', 'WILLOW',
  'ACORN', 'BIRCH', 'COMET', 'DUNE', 'FJORD', 'GROVE', 'HAZEL', 'ISLE'
] as const

/** First 8 hex characters of SHA-256 over the guide text without its phrase line. */
export function guideVersion(markdownWithoutPhrase: string): string {
  return createHash('sha256').update(markdownWithoutPhrase, 'utf8').digest('hex').slice(0, 8)
}

/**
 * The check phrase derived from the version hash: two words from PHRASE_WORDS
 * joined with `-`, then `-` and a number from 10 to 99. Example: KETTLE-CEDAR-42.
 */
export function guidePhrase(version: string): string {
  const first = parseInt(version.slice(0, 2), 16) % PHRASE_WORDS.length
  const second = parseInt(version.slice(2, 4), 16) % PHRASE_WORDS.length
  const number = 10 + (parseInt(version.slice(4, 6), 16) % 90)
  return `${PHRASE_WORDS[first]}-${PHRASE_WORDS[second]}-${number}`
}

/** The section the phrase line sits in; also used to strip it before hashing. */
export const PHRASE_LINE_PREFIX = 'Check phrase: '

/** The PC section for the "not installed" case. */
function botPcsNotInstalled(): string {
  return `## Bot PCs

Bot PCs aren't set up on this computer yet. If the user asks for bot PC work,
tell them to open Deskmates → Bots → Set up bot PCs. Don't create Linux
machines, WSL distros or Docker containers yourself. The \`pc\` commands of the
deskmates command will tell you the same.
`
}

/** The PC section for the "installed" case, with the mode and the shared folder. */
function botPcsInstalled(pcs: { mode: 'own' | 'shared'; sharedFolder: string }, command: string): string {
  const mode =
    pcs.mode === 'own'
      ? `Each bot has its own PC with its own logins and files, so bots can run at the same time.`
      : `All bots share one PC with one set of logins and files, and they take turns.`
  return `## Bot PCs

The user's bots run on small Linux computers ("bot PCs") that Deskmates manages.
${mode}

- \`${command}\` pc list — list the PCs and whether each one is busy.
- \`${command}\` pc exec <pc> -- <command> — run a shell command on a PC.
- \`${command}\` pc open <pc> <url> — open a page in the PC's browser.
- \`${command}\` pc screenshot <pc> <out.png> — save a screenshot of the PC.

The folder ${pcs.sharedFolder} appears as \`/shared\` inside every PC;
use it to pass files to and from bots.

Never type passwords or one-time codes into a PC. When a site needs a login,
ask the user to log in through Take over in Deskmates. Never message anyone
except the user from a bot's accounts. Bots may be running scheduled jobs, so
check \`pc list\` before using a PC and don't interrupt a busy one.
`
}

/** The Designs (Design tab) section. */
function designsSection(dataDir: string, command: string): string {
  return `## Designs (the Design tab)

The Design tab holds web pages the user designs with AI and edits by hand in a
live preview. Each design is a folder:

${join(dataDir, 'designs', '<id>', 'index.html')}

- \`${command}\` design list — list the designs (id and name).
- \`${command}\` design path <id> — print the full path of a design's index.html.

To change a design, edit its \`index.html\` directly with your own file tools, or
use \`${command}\` design write <id> <file> (use \`-\` as the file to read the
HTML from stdin). The preview in Deskmates reloads by itself. To make a new
design: \`${command}\` design create "<name>" [--prompt "<text>"].

Design rules:

- One self-contained file with inline CSS. No frameworks unless the user asks.
- Google Fonts links and https images are fine.
- Responsive at 1440, 834 and 390 pixels wide.
- Keep every \`data-dm-id\` attribute exactly as it is and never invent new ones.
  They tie the page to the user's direct edits.
- Inline \`translate\`, \`width\`, \`height\` and font styles are usually the user's
  hand edits, so keep them.
- No scripts that send data anywhere, no trackers, no analytics.
- Don't edit a design while the Deskmates assistant is working on it.

When the user's message contains a block like:

Selected element (data-dm-id="abc123", button):

it names the element the user selected in the preview. Change only that element
(don't touch its \`data-dm-id\`), unless the user says otherwise.

Ask the user before deleting a design.
`
}

/** The closing Good to know section. */
function goodToKnowSection(dataDir: string): string {
  return `## Good to know

The app's data folder is ${dataDir}. Don't edit anything in it other than
design files: never the database, settings, snapshots or the agent-kit folder.
Never read or copy API keys.
`
}

/** The operating-instructions section, shown when the mounted claude-code prompt exists. */
function operatingPromptSection(input: AgentGuideInput): string {
  if (!input.operatingPromptPath) return ''
  return `## Your operating instructions

The app gives you an operating prompt at:

${input.operatingPromptPath}

Read it before doing anything else and follow it whenever it applies. This
guide then adds the Deskmates-specific rules below.
`
}

/**
 * Builds the guide text, version and check phrase. The version is the first 8
 * hex characters of SHA-256 over the guide text without its phrase line, and
 * the phrase is derived from that same hash, so both are stable while the
 * guide text doesn't change.
 */
export function buildAgentGuide(input: AgentGuideInput): Omit<AgentGuide, 'path'> {
  // The guide shows the command by name, so agents type `deskmates` on Linux/macOS and
  // `deskmates.cmd` on Windows. Derived from the real path, so the two can't drift apart.
  const command = basename(input.commandPath)
  const pcSection = input.pcs.installed ? botPcsInstalled(input.pcs, command) : botPcsNotInstalled()
  // The phrase line starts as a placeholder; the version hash covers the text
  // with that whole line removed, so changing the phrase can never change it.
  const withoutPhrase = `# Deskmates guide for coding agents

Deskmates app version: ${input.appVersion}

Deskmates is a ${hostOs()} desktop app the user runs. It has:

- the Work tab, where an assistant works in project folders;
- the Design tab, web pages the user designs with AI and edits by hand in a
  live preview;
- bot PCs, small Linux computers where the user's bots browse the web and send
  messages.

You are connected to it, and you may be asked to work on designs or on bot PCs.
Read all of it.

${operatingPromptSection(input)}## Check-in

When Deskmates asks you to check in, reply with exactly one line: the word
DESKMATES, then the word READY, then the check phrase below, separated by
single spaces. Reply with only that line, nothing else.

${PHRASE_LINE_PREFIX}{phrase} · guide {version}

## The deskmates command

Deskmates gives you a command line tool. Run it as:

    "${input.commandPath}" <command>

Add --json to any command for JSON output. The commands:

- guide — print this guide.
- design list — list the designs.
- design path <id> — print a design's index.html path.
- design read <id> — print a design's HTML.
- design write <id> <file> — replace a design's HTML (use \`-\` to read stdin).
- design create "<name>" [--prompt "<text>"] — make a new design.
- pc list — list the bot PCs.
- pc exec <pc> -- <command> — run a command on a bot PC.
- pc open <pc> <url> — open a page on a bot PC.
- pc screenshot <pc> <out.png> — screenshot a bot PC.
- mcp — run the same actions as an MCP server on stdio, for agents that
  support MCP.

If Deskmates isn't running, the command tells you so; start the app and retry.

## Guiding the user on their screen

Over MCP you also get screen tools, for when the user asks you to show them
where something is or how to do something on their computer:

- screen_look — a screenshot of their main screen.
- screen_point — draw arrows, circles, boxes or labels over it, in the
  pixels of your latest screen_look. Look again before pointing, since the
  screen may have changed.
- screen_say — say a sentence or two aloud.
- screen_clear — remove your marks.

These only show and tell: they never click or type for the user.

## The agent browser

Over MCP you also get Deskmates' agent browser (browser_open, browser_read,
browser_click, browser_type, browser_key, browser_scroll, browser_back,
browser_tabs, browser_wait): real pages the user can watch and use from the
globe button at the top right of Deskmates. Pages come back as text plus
numbered elements; click and type by number, and read again after a change.

- Sign-ins are the user's. Password, code, card and ID fields are refused:
  ask the user to sign in in the browser panel, then continue.
- The first click or typing on a site asks the user; anything that sends,
  posts, pays, signs or deletes asks again. On LinkedIn only the user
  presses Send.
- If the user is using the browser, your action waits until they hand it
  back.

## Keeping the user posted

The user watches your work in Deskmates as it happens. When you take a
request, start with one short line saying what you are going to do. Before
each new step, write one short sentence saying what you are doing now and
why, then do it. If something changes the plan (a step failed, a page
needs their sign-in), say so before going on. Keep these lines brief, in
the user's language; the full answer still comes at the end.

## Asking the user

When you need the user to decide something, end your reply with the
question on its own line and a numbered list of 2 to 5 short options.
Deskmates shows them as buttons, and the user can still type an answer.

## Scheduled tasks

Scheduled tasks ("every weekday at 7:30") live in Deskmates: the user adds
them on a project's page, or asks the Work assistant. A scheduled task on a
command-line model (you) never starts by itself; it waits for the user to
press Start.

${designsSection(input.dataDir, command)}
${pcSection}
${goodToKnowSection(input.dataDir)}
`
  const hash = createHash('sha256')
  // Strip the whole phrase line (it carries the version itself, which keeps
  // the hash free of circularity).
  hash.update(withoutPhrase.replace(new RegExp(`^${PHRASE_LINE_PREFIX}.*\\n`, 'm'), ''), 'utf8')
  const version = hash.digest('hex').slice(0, 8)
  const phrase = guidePhrase(version)
  return {
    markdown: withoutPhrase.replace('{version}', version).replace('{phrase}', phrase),
    version,
    phrase
  }
}

/**
 * Builds the guide and writes it to <agentKitDir>/DESKMATES-AGENTS.md, but only
 * when the content changed, so the file's mtime stays a reliable signal for the
 * designs watcher and for the check-in logic.
 */
export function writeAgentGuide(input: AgentGuideInput): AgentGuide {
  const dir = agentKitDir(input.dataDir)
  const path = join(dir, 'DESKMATES-AGENTS.md')
  const built = buildAgentGuide(input)
  let unchanged = false
  try {
    const stats = statSync(path)
    unchanged = stats.isFile() && readFileSync(path, 'utf8') === built.markdown
  } catch {
    unchanged = false
  }
  if (!unchanged) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, built.markdown, 'utf8')
  }
  return { ...built, path }
}
