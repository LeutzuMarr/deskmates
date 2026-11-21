import { execFile, execFileSync } from 'node:child_process'
import { ConsoleHelper } from './freebuff-console'
import { parsePickerCards, type FreebuffModel, type FreebuffStatus } from '../../shared/freebuff'

/** Box-drawing and block characters Freebuff's TUI draws borders with. */
const BORDER = /[─-▟]/g
/** The line that closes a finished reply: a copy icon and the turn's duration, e.g. "⎘ • 3s • △▽". */
const REPLY_FOOTER = /⎘\s*•\s*\d/
const BUSY = /■\s*Esc|thinking\.\.\./
const IDLE_PLACEHOLDER = /Enter a coding task or \/ for commands/
/** Both placeholders Freebuff shows in an empty input box: idle, and while a turn runs. */
const ANY_PLACEHOLDER = /Enter a coding task or \/ for commands|Add to the current task \(\/ for commands\)/i
const SURVEY = /quick question \d+\/\d+/i
const RETRY = /Enter: retry/

/** The /model picker's key help line, shown while it is open. */
const PICKER = /choose model · Tab reasoning · Enter select/

export const isBusy = (screen: string): boolean => BUSY.test(screen)
export const hasSurvey = (screen: string): boolean => SURVEY.test(screen)
export const hasRetry = (screen: string): boolean => RETRY.test(screen)

/** The model the /model picker has highlighted ("│ › Solar Pro 4 · Upstage flagship │"), or null. */
export function highlightedModel(screen: string): string | null {
  const match = /│\s*›\s*(.+?)\s+[•·]/.exec(screen)
  return match ? match[1].trim() : null
}

/** The session facts Freebuff prints: its status bar ("Solar Pro 4 · ~\folder · /model to change"),
 *  the time left ("34m left · 35K (7%)") and the banner's "12/12 hours remaining". */
export function readStatus(screen: string): Omit<FreebuffStatus, 'updatedAt'> {
  // The model is the segment just before the folder and "/model to change". Anything further left on
  // that line is Freebuff's keyboard hint ("↻ ← for history · ? for help"), not the model.
  const segment = /([^·\n]+?)\s*·\s*[^·\n]*·\s*\/model to change/.exec(screen)?.[1]?.trim() ?? ''
  const model = segment && !/for (history|help)|[←→↑↓↻⟳]/.test(segment) ? segment : null
  // "34m left", "1h 5m left" or "1h left".
  const time = /(?:(\d+)h\s*)?(?:(\d+)m)?\s*left ·/.exec(screen)
  const hours = /(\d+)\/(\d+) hours remaining/.exec(screen)
  const context = /left · ([\d.]+[KM]? \(\d+%\))/.exec(screen)
  return {
    model,
    sessionMinutesLeft: time && (time[1] || time[2]) ? Number(time[1] ?? 0) * 60 + Number(time[2] ?? 0) : null,
    hoursLeftToday: hours ? Number(hours[1]) : null,
    hoursPerDay: hours ? Number(hours[2]) : null,
    context: context ? context[1] : null
  }
}

/**
 * What's typed in Freebuff's input box: '' when it's empty (showing a placeholder), the leftover text
 * otherwise, and null when no input box is on screen. The input box is the last box on screen, and
 * the only one drawn from the very first column (ad cards are indented by one).
 */
export function inputDraft(screen: string): string | null {
  const lines = screen.split('\n')
  let bottom = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('╰')) {
      bottom = i
      break
    }
  }
  if (bottom < 0) return null
  let top = bottom - 1
  while (top >= 0 && !lines[top].startsWith('╭')) top--
  if (top < 0) return null
  const text = lines
    .slice(top + 1, bottom)
    .map((line) => line.replace(/^│/, '').replace(/│\s*$/, '').replace(/▍/g, '').trim())
    .filter(Boolean)
    .join('\n')
  return ANY_PLACEHOLDER.test(text) ? '' : text
}

/** Ready for a new request: not working, and an input box on screen. */
export const isIdle = (screen: string): boolean => !isBusy(screen) && inputDraft(screen) !== null

/** Thrown out of `ask` when the user stopped the turn. */
export class StoppedError extends Error {
  constructor() {
    super('Stopped.')
    this.name = 'StoppedError'
  }
}

/** The screen without the blinking input cursor, for telling real changes from the blink. */
export const withoutCursor = (screen: string): string => screen.replace(/▍/g, ' ')

const clean = (line: string): string => line.replace(BORDER, ' ').replace(/\s+/g, ' ').trim()
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Where `prompt` is echoed in the chat, oldest first. Only lines above the input box count: the
 * status bar under it repeats the chat's first request as the chat title.
 */
function echoLines(lines: string[], prompt: string): number[] {
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('╭')) {
      end = i
      break
    }
  }
  const head = squash(prompt).slice(0, 24)
  const found: number[] = []
  for (let i = 0; i < end; i++) {
    // The first line of an echo starts the prompt; a wrapped continuation of an earlier echo doesn't.
    if (squash(lines[i]).startsWith(head)) found.push(i)
  }
  return found
}

/** How many times `prompt` is already in the chat, so a repeated question isn't mistaken as answered. */
export function countEchoes(screen: string, prompt: string): number {
  return echoLines(screen.split('\n'), prompt).length
}

/**
 * The reply to `prompt` on Freebuff's screen: the lines between the echo of the prompt (which ends
 * with a copy icon "⎘") and the reply's own footer. Null until the echo is on screen.
 */
export function extractReply(screen: string, prompt: string, skipEchoes = 0): { text: string; done: boolean } | null {
  const lines = screen.split('\n')
  const echoes = echoLines(lines, prompt)
  // A request asked before (and still on screen) doesn't count until a new copy of it appears.
  if (echoes.length <= skipEchoes) return null
  const echo = echoes[echoes.length - 1]
  // The echo can wrap over several lines; it ends on the first line with the copy icon.
  let start = echo
  while (start < lines.length && !lines[start].includes('⎘')) start++
  const body: string[] = []
  let done = false
  for (let i = start + 1; i < lines.length; i++) {
    if (REPLY_FOOTER.test(lines[i])) {
      done = true
      break
    }
    // The ad card or the input box: the reply is over (or still being written).
    if (/^\s*[╭┌]/.test(lines[i]) || IDLE_PLACEHOLDER.test(lines[i])) break
    body.push(clean(lines[i]))
  }
  while (body.length && !body[0]) body.shift()
  while (body.length && !body[body.length - 1]) body.pop()
  return { text: body.join('\n'), done }
}

/**
 * The latest finished reply on screen, found from its footer ("⎘ • 3s") rather than from the request's
 * echo: the lines above the last footer, up to the line before it that ends a request or a reply (both
 * carry a copy icon) or the top of the screen. For a long turn whose request has scrolled off the top
 * of Freebuff's window, where `extractReply` has nothing to anchor on. Null when no footer is on screen.
 */
export function latestReply(screen: string): string | null {
  const lines = screen.split('\n')
  let footer = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REPLY_FOOTER.test(lines[i])) {
      footer = i
      break
    }
  }
  if (footer < 0) return null
  const body: string[] = []
  for (let i = footer - 1; i >= 0; i--) {
    if (lines[i].includes('⎘') || /^\s*[╭┌╰└│]/.test(lines[i])) break
    body.unshift(clean(lines[i]))
  }
  while (body.length && !body[0]) body.shift()
  while (body.length && !body[body.length - 1]) body.pop()
  return body.join('\n')
}

/** The last line of chat above the input box (and any card over it), for when the request's echo has
 *  scrolled away. Null when there is none. */
function lastChatLine(screen: string): string | null {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*[╭┌╰└│]/.test(line) || BUSY.test(line) || / left · /.test(line) || /\/model to change/.test(line)) continue
    const text = clean(line)
    if (text) return text.slice(0, 120)
  }
  return null
}

/** What to say aloud from a reply: the prose, without the tool and command lines Freebuff prints. */
export function spokenText(reply: string): string {
  return reply
    .split('\n')
    .filter((line) => line && !/^(\$ |• |▸ |\/usr\/bin|[A-Z]:\\)/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The last line of work Freebuff shows while busy ("• Read file.ts", "$ npm test"), for the notch. */
export function currentActivity(screen: string, prompt: string, skipEchoes = 0): string | null {
  const reply = extractReply(screen, prompt, skipEchoes)
  // A long turn pushes the request off the top of the window; its work is still at the bottom.
  if (!reply) return lastChatLine(screen)
  // Freebuff's own "thinking... 2s ■ Esc" status isn't activity worth showing.
  const lines = reply.text.split('\n').filter((line) => line && !BUSY.test(line))
  const last = lines[lines.length - 1]
  return last ? last.slice(0, 120) : null
}

/** A line that starts a new piece of work in Freebuff's output: a tool or command line. */
const WORK_MARKER = /^(\$ |• |▸ |✓ |✗ |✔ |✘ |→ )/
/** Whether an item of Freebuff's output is a line of work (a tool or command) rather than prose. */
export function isWorkLine(text: string): boolean {
  return WORK_MARKER.test(text.trim())
}

/** Freebuff's window is 110 columns; a cleaned line this long was most likely wrapped onto the next. */
const WRAP_LENGTH = 95

/**
 * Freebuff's output lines turned into whole items, in order: each tool or command line is its own
 * item, and a paragraph of prose (which the window wraps over several lines) is joined back into one.
 * Freebuff's own "thinking…" status is left out.
 */
export function groupWork(lines: string[]): string[] {
  const items: string[] = []
  let joinable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || BUSY.test(line)) {
      joinable = false
      continue
    }
    const marker = WORK_MARKER.test(line)
    if (!marker && joinable && items.length > 0) {
      items[items.length - 1] += ` ${line}`
    } else {
      items.push(line)
    }
    // A line continues onto the next only when it filled the window's width (it wrapped): two short
    // lines are two things Freebuff said, and each gets its own step.
    joinable = line.length >= WRAP_LENGTH
  }
  return items
}

/** Every chat line on screen above the input box, without boxes, cards, footers or the status bar. */
function chatLines(screen: string): string[] {
  return screen
    .split('\n')
    .filter((line) => !/^\s*[╭┌╰└│]/.test(line) && !REPLY_FOOTER.test(line) && !line.includes('⎘') && !/ left · /.test(line) && !/\/model to change/.test(line))
    .map(clean)
}

/**
 * Everything Freebuff has written for `prompt` so far, as whole items (see `groupWork`). When the
 * request has scrolled off the top of the window, every chat line still on screen is this turn's.
 */
export function workItems(screen: string, prompt: string, skipEchoes = 0): string[] {
  const reply = extractReply(screen, prompt, skipEchoes)
  if (reply) return groupWork(reply.text.split('\n'))
  // The top line may be the tail of a paragraph cut by the window's edge (reported whole earlier):
  // drop it then, but keep a tool or command line, which is never cut.
  const items = groupWork(chatLines(screen))
  return items.length > 0 && !WORK_MARKER.test(items[0]!) ? items.slice(1) : items
}

export type FreebuffState = 'starting' | 'idle' | 'busy' | 'stopped' | 'error'

export interface FreebuffHostOptions {
  /** The folder Freebuff works in. */
  workspace: string
  onState: (state: FreebuffState, detail?: string) => void
  /** The latest line of work while a turn runs ("• Read file.ts"), for showing progress. */
  onActivity?: (activity: string) => void
  /** Load the folder's .agents files and mcp.json without Freebuff asking first. Off for project
   *  folders the user didn't set up for this. */
  trustAgents?: boolean
}

const POLL_MS = 500
const TURN_TIMEOUT_MS = 15 * 60_000
const START_TIMEOUT_MS = 45_000
/** How long the screen must stay idle and unchanged before a turn counts as finished. */
const SETTLE_MS = 1500
/** How long Freebuff may sit idle, after working, with no reply footer on screen before the turn is
 *  taken as over anyway. */
const IDLE_GIVE_UP_MS = 20_000

/**
 * Runs Freebuff in a console window nobody sees and talks to it the way a person would: typing
 * into it and reading its screen. Freebuff has no non-interactive mode, so this is the only way in.
 */
export class FreebuffHost {
  private hostPid: number | null = null
  private helper: ConsoleHelper | null = null
  private screen = ''
  private screenAt = 0
  private state: FreebuffState = 'stopped'
  private starting: Promise<void> | null = null
  private screenWaiters: Array<() => void> = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopRequested = false
  /** Copies of the current request already in the chat before it was sent (an earlier, identical ask). */
  private echoesBefore = 0
  /** Freebuff and the processes above it, up to and including its hidden console. */
  private processes = new Set<number>()
  private lastHours: { left: number; total: number | null } | null = null
  /** Progress callback for the turn in flight: everything Freebuff has written so far, in order. */
  private turnWork: ((items: string[]) => void) | null = null

  constructor(private readonly options: FreebuffHostOptions) {}

  get current(): FreebuffState {
    return this.state
  }

  start(): Promise<void> {
    this.starting ??= this.boot().catch((error: unknown) => {
      this.starting = null
      this.setState('error', error instanceof Error ? error.message : String(error))
      throw error
    })
    return this.starting
  }

  private async boot(): Promise<void> {
    this.setState('starting')
    const ws = this.options.workspace
    const trust = this.options.trustAgents ? ' --trust-agents' : ''
    this.hostPid = await startHiddenConsole(`cmd.exe /c mode con cols=110 lines=70 & freebuff --cwd "${ws}"${trust}`)
    const pid = await this.findFreebuffPid(ws)
    this.processes = await processChain(pid, this.hostPid)
    const helper = new ConsoleHelper(pid, () => {
      if (this.helper === helper) this.onGone('Lost the connection to Freebuff.')
    })
    this.helper = helper
    helper.onEvent((event) => {
      if (event.event === 'screen') {
        // The input box's cursor blinks, so it's left out: otherwise the screen never looks settled.
        if (withoutCursor(event.text) !== withoutCursor(this.screen)) this.screenAt = Date.now()
        this.screen = event.text
        const waiters = this.screenWaiters
        this.screenWaiters = []
        waiters.forEach((wake) => wake())
      } else if (event.event === 'error') {
        console.error('[core] freebuff console helper:', event.message)
      }
    })
    const timer = setInterval(() => helper.send({ cmd: 'poll' }), POLL_MS)
    const deadline = Date.now() + START_TIMEOUT_MS
    while (!isIdle(this.screen)) {
      if (Date.now() > deadline) {
        clearInterval(timer)
        throw new Error(
          "Freebuff didn't finish starting. Run `freebuff` once in a terminal in this folder (to sign in, or to answer a question it asks there), then try again."
        )
      }
      await this.nextScreen()
    }
    this.pollTimer = timer
    this.setState('idle')
  }

  /** Sends one request and resolves with Freebuff's reply once the turn is over. Rejects with
   *  `StoppedError` when `cancel()` ends the turn first. */
  async ask(prompt: string, onWork?: (items: string[]) => void): Promise<string> {
    await this.start()
    if (this.state === 'busy') throw new Error('Freebuff is still working on the last request.')
    this.stopRequested = false
    this.turnWork = onWork ?? null
    this.setState('busy')
    try {
      // Type, then check the request really started; if the letters were dropped, try once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.prepareInput()
        this.echoesBefore = countEchoes(this.screen, prompt)
        this.typeText(prompt)
        if (await this.landed(prompt)) break
        if (attempt === 1) throw new Error("Freebuff didn't take the request. Try again.")
      }
      return await this.waitForReply(prompt)
    } finally {
      if (this.current === 'busy') this.setState('idle')
    }
  }

  /** Stops the running turn: presses Esc in Freebuff and ends Deskmates' wait for the reply at once. */
  cancel(): void {
    if (this.state === 'busy') this.stopRequested = true
    this.press(['escape'])
  }

  /**
   * Presses keys in Freebuff. Each press is preceded by a "focus in" signal: Freebuff ignores typing
   * while it believes its window is in the background, and its window is hidden, so it always would.
   */
  private press(keys: string[]): void {
    this.helper?.send({ cmd: 'focus' })
    this.helper?.send({ cmd: 'keys', keys })
  }

  /** Types `text` and presses Enter, after the same "focus in" signal as `press`. */
  private typeText(text: string): void {
    this.helper?.send({ cmd: 'focus' })
    this.helper?.send({ cmd: 'type', text })
  }

  /** What Freebuff's screen says about the session right now. The daily hours only show in the banner
   *  at the top of a chat, so the last value seen is kept once it scrolls away. */
  status(): FreebuffStatus {
    const read = readStatus(this.screen)
    if (read.hoursLeftToday !== null) this.lastHours = { left: read.hoursLeftToday, total: read.hoursPerDay }
    return {
      ...read,
      hoursLeftToday: read.hoursLeftToday ?? this.lastHours?.left ?? null,
      hoursPerDay: read.hoursPerDay ?? this.lastHours?.total ?? null,
      updatedAt: Date.now()
    }
  }

  /**
   * Switches Freebuff to `name` through its own /model picker: opens it, walks to the top, then down
   * until the highlighted row is that model, and presses Enter. Does nothing when it's already
   * selected; throws (after closing the picker) when the picker has no such model.
   */
  async selectModel(name: string): Promise<void> {
    await this.start()
    if (this.state === 'busy') throw new Error('Freebuff is still working on the last request.')
    if (readStatus(this.screen).model === name) return
    this.setState('busy')
    try {
      await this.prepareInput()
      this.typeText('/model')
      if (!(await this.waitFor((screen) => PICKER.test(screen), 8000))) throw new Error("Freebuff's model picker didn't open.")
      // To the top first, so the walk down sees every model once.
      let previous: string | null = null
      for (let i = 0; i < 40; i++) {
        this.press(['up'])
        await delay(350)
        await this.nextScreen()
        const highlighted = highlightedModel(this.screen)
        if (highlighted === previous) break
        previous = highlighted
      }
      for (let i = 0; i < 40; i++) {
        const highlighted = highlightedModel(this.screen)
        if (highlighted && highlighted.startsWith(name)) {
          this.press(['enter'])
          await this.waitFor((screen) => !PICKER.test(screen), 5000)
          return
        }
        this.press(['down'])
        await delay(350)
        await this.nextScreen()
        if (highlightedModel(this.screen) === highlighted) break // the bottom: it isn't listed
      }
      this.press(['escape'])
      throw new Error(`Freebuff doesn't list "${name}" any more. Pick another Freebuff model in Deskmates.`)
    } finally {
      if (this.current === 'busy') this.setState('idle')
    }
  }

  /**
   * Reads every model Freebuff's /model picker offers, with its cost: opens the picker, walks to the
   * top, then down to the bottom collecting the cards on each screen, and closes it with Esc, so the
   * selected model stays as it was. Only runs on an idle, already started Freebuff; returns null
   * otherwise, or when the picker didn't open.
   */
  async listModels(): Promise<FreebuffModel[] | null> {
    if (this.state !== 'idle') return null
    this.stopRequested = false
    this.setState('busy')
    let opened = false
    try {
      await this.prepareInput()
      this.typeText('/model')
      if (!(await this.waitFor((screen) => PICKER.test(screen), 8000))) return null
      opened = true
      const found = new Map<string, FreebuffModel>()
      const collect = (): void => {
        for (const card of parsePickerCards(this.screen)) if (!found.has(card.name)) found.set(card.name, card)
      }
      // Stop at once if a turn cancelled this read or the picker closed: further arrow keys would
      // walk the chat input through its history instead.
      const interrupted = (): boolean => this.stopRequested || !PICKER.test(this.screen)
      let previous: string | null = null
      for (let i = 0; i < 60; i++) {
        this.press(['up'])
        await delay(250)
        await this.nextScreen()
        if (interrupted()) return null
        const highlighted = highlightedModel(this.screen)
        if (highlighted === previous) break
        previous = highlighted
      }
      // Order is the picker's, top to bottom: collect from the top screen first, then each step down.
      found.clear()
      collect()
      for (let i = 0; i < 60; i++) {
        const highlighted = highlightedModel(this.screen)
        this.press(['down'])
        await delay(250)
        await this.nextScreen()
        if (interrupted()) return null
        collect()
        if (highlightedModel(this.screen) === highlighted) break
      }
      return [...found.values()]
    } finally {
      if (opened && PICKER.test(this.screen)) {
        this.press(['escape'])
        await this.waitFor((screen) => !PICKER.test(screen), 5000)
      }
      if (this.current === 'busy') this.setState('idle')
    }
  }

  /** Waits until `test` holds for the screen, up to `ms`. */
  private async waitFor(test: (screen: string) => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      await this.nextScreen()
      if (test(this.screen)) return true
    }
    return false
  }

  /** Resolves once no turn is running (after `cancel()`, the stopped turn has wound down). */
  async whenFree(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.state === 'busy' && Date.now() < deadline) await delay(200)
  }

  /** Whether `pid` is one of Freebuff's own processes, including its hidden console window. */
  owns(pid: number): boolean {
    return this.processes.has(pid)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.helper?.send({ cmd: 'exit' })
    this.helper?.kill()
    this.helper = null
    // Synchronous: this also runs as the app quits, and a kill started in the background can be lost
    // with the exiting process, leaving a hidden Freebuff running.
    if (this.hostPid) {
      try {
        execFileSync('taskkill', ['/pid', String(this.hostPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
      } catch {
        // Already gone.
      }
    }
    this.hostPid = null
    this.processes = new Set()
    this.starting = null
    this.setState('stopped')
  }

  /**
   * Makes sure typed text lands in an empty input box: dismisses a survey card, steps out of the
   * prompt history (Down), and deletes anything left in the box. Leftover text would otherwise be
   * sent along with the request.
   */
  private async prepareInput(): Promise<void> {
    // Freebuff's input box isn't always focused (after start-up, a survey, or a reply), and then it
    // drops typed letters; a lone "?" even opens its help. Escape focuses the box and closes help.
    // Safe here: this only runs while no turn is in progress, so Escape can't stop anything.
    this.press(['escape'])
    await delay(500)
    let steppedOutOfHistory = false
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.nextScreen()
      if (hasSurvey(this.screen)) {
        this.press(['escape'])
        await delay(600)
        continue
      }
      const draft = inputDraft(this.screen)
      if (draft === null || draft === '') return
      if (!steppedOutOfHistory) {
        steppedOutOfHistory = true
        this.press(['down'])
        await delay(400)
        continue
      }
      const count = Math.min(2000, draft.length + 20)
      this.press(Array.from({ length: count }, () => 'backspace'))
      await delay(count * 20 + 400)
    }
  }

  /** Whether the request shows up in the chat (or Freebuff got busy) shortly after typing it. If the
   *  text is sitting in the input box unsent, presses Enter for it. */
  private async landed(prompt: string): Promise<boolean> {
    const deadline = Date.now() + 8000
    let pressedEnter = false
    while (Date.now() < deadline) {
      await this.nextScreen()
      if (this.stopRequested) return true
      if (extractReply(this.screen, prompt, this.echoesBefore) || isBusy(this.screen)) return true
      const draft = inputDraft(this.screen)
      if (!pressedEnter && draft && squash(draft).includes(squash(prompt).slice(0, 24))) {
        pressedEnter = true
        this.press(['enter'])
      }
    }
    return false
  }

  private async waitForReply(prompt: string): Promise<string> {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    const startBy = Date.now() + 20_000
    let started = false
    let sawBusy = false
    /** The reply as last seen while its request was still on screen. */
    let lastText = ''
    let retries = 0
    for (;;) {
      await this.nextScreen()
      const screen = this.screen
      if (this.stopRequested) {
        // Give Freebuff a moment to wind down, pressing Esc again if it keeps going.
        const until = Date.now() + 8000
        let lastEsc = Date.now()
        while (isBusy(this.screen) && Date.now() < until) {
          if (Date.now() - lastEsc > 2000) {
            this.press(['escape'])
            lastEsc = Date.now()
          }
          await this.nextScreen()
        }
        throw new StoppedError()
      }
      const reply = extractReply(screen, prompt, this.echoesBefore)
      if (reply?.text) lastText = reply.text
      if (isBusy(screen)) sawBusy = true
      if (reply || isBusy(screen)) started = true
      if (!started && Date.now() > startBy) throw new Error("Freebuff didn't take the request. Try again.")
      if (Date.now() > deadline) throw new Error('Freebuff took too long, so Deskmates stopped waiting.')
      if (hasRetry(screen)) {
        if (retries++ >= 2) throw new Error("Freebuff's server didn't answer. Try again in a moment.")
        this.press(['enter'])
        await delay(1000)
        continue
      }
      if (hasSurvey(screen)) this.press(['escape'])
      if (started && isBusy(screen)) {
        const activity = currentActivity(screen, prompt, this.echoesBefore)
        if (activity) this.options.onActivity?.(activity)
        this.turnWork?.(workItems(screen, prompt, this.echoesBefore))
      }
      const settled = Date.now() - this.screenAt > SETTLE_MS
      if (started && reply?.done && isIdle(screen) && settled) {
        // The last lines can land between two polls of a busy screen: report the finished reply too.
        this.turnWork?.(workItems(screen, prompt, this.echoesBefore))
        return reply.text
      }
      // A long turn (browsing, reading a site) prints more than Freebuff's window holds, and the
      // request scrolls off the top: `extractReply` then has nothing to anchor on and would wait for
      // the full timeout while the answer sits right there. Freebuff idle again after working means
      // the turn is over, so the reply is read from above its footer instead.
      if (sawBusy && !reply?.done && isIdle(screen) && settled) {
        // Only with the request gone from the screen: while it shows, the last footer could still be
        // the previous turn's, above it.
        const fallback = reply ? null : latestReply(screen)
        if (fallback) return fallback
        if (fallback === '' && lastText) return lastText
        // Idle with no footer at all (an error card, say): give it a while, then hand back what was seen.
        if (Date.now() - this.screenAt > IDLE_GIVE_UP_MS) return lastText || (lastChatLine(screen) ?? '')
      }
    }
  }

  private nextScreen(): Promise<void> {
    return new Promise((resolve) => {
      this.screenWaiters.push(resolve)
      setTimeout(resolve, POLL_MS * 3)
    })
  }

  private findFreebuffPid(workspace: string): Promise<number> {
    const deadline = Date.now() + START_TIMEOUT_MS
    const needle = workspace.toLowerCase()
    const look = (): Promise<number | null> =>
      new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='freebuff.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"],
          { windowsHide: true, timeout: 15_000 },
          (_error, stdout) => {
            try {
              const parsed = JSON.parse(stdout || 'null') as unknown
              const rows = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as Array<{ ProcessId: number; CommandLine: string | null }>
              const row = rows.find((r) => (r.CommandLine ?? '').toLowerCase().includes(needle))
              resolve(row ? row.ProcessId : null)
            } catch {
              resolve(null)
            }
          }
        )
      })
    return (async () => {
      while (Date.now() < deadline) {
        const pid = await look()
        if (pid) return pid
        await delay(1000)
      }
      throw new Error("Couldn't start Freebuff. Check that `freebuff` works in a terminal.")
    })()
  }

  private onGone(reason: string): void {
    if (this.state === 'stopped') return
    this.stop()
    this.setState('error', reason)
  }

  private setState(state: FreebuffState, detail?: string): void {
    this.state = state
    this.options.onState(state, detail)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `pid` and its parents, stopping at `top` (Freebuff's hidden conhost). Windows reports the console
 * window as belonging to one of these, so this is how Deskmates recognises it.
 */
function processChain(pid: number, top: number | null): Promise<Set<number>> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (_error, stdout) => {
        const chain = new Set<number>([pid])
        if (top) chain.add(top)
        try {
          const rows = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number }>
          const parentOf = new Map(rows.map((r) => [r.ProcessId, r.ParentProcessId]))
          let current = parentOf.get(pid)
          for (let hops = 0; current && hops < 6 && !chain.has(current); hops++) {
            chain.add(current)
            if (current === top) break
            current = parentOf.get(current)
          }
        } catch {
          // Keep what we know.
        }
        resolve(chain)
      }
    )
  })
}

/**
 * Starts `commandLine` in a console window nobody sees and resolves with that console's pid.
 *
 * conhost.exe, not the default terminal: Windows Terminal would ignore the hidden window state. It
 * goes through PowerShell's Start-Process because conhost spawned straight from Node exits at once
 * (tried with and without `detached`), while Start-Process -WindowStyle Hidden keeps it running.
 * `mode` in the command gives the console room, so long replies aren't cut off.
 */
function startHiddenConsole(commandLine: string): Promise<number> {
  const quoted = commandLine.replace(/'/g, "''")
  const script = `(Start-Process conhost.exe -ArgumentList '${quoted}' -WindowStyle Hidden -PassThru).Id`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      const pid = Number(stdout.trim())
      if (error || !Number.isInteger(pid) || pid <= 0) reject(new Error("Couldn't start Freebuff's hidden console."))
      else resolve(pid)
    })
  })
}
