/** One-line primer sent right after connecting, before the user's first prompt. When `promptPath`
 *  is given (the user's claude-code base prompt in prompts/), the agent is told to read it as well,
 *  so it follows that prompt as well as the CLI's own. */
export function buildPrimer(input: { guidePath: string; promptPath?: string }): string {
  const instructions = input.promptPath
    ? ` and read your operating instructions at "${input.promptPath}" and follow them`
    : ''
  return (
    `Deskmates connected you to its app. Before your next reply, read the guide at "${input.guidePath}" ` +
    `(it explains the Design tab, the bot PCs and the deskmates command),${instructions} then reply with only the ` +
    `check-in line it describes.`
  )
}

/** Strips ANSI escape sequences (CSI, OSC and two-character escapes). */
function stripAnsi(text: string): string {
  // prettier-ignore
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-_]/g, '')
}

/** The box-drawing block and the markdown characters the matcher ignores. */
const NOISE = /[\u2500-\u257f*_`>#]/g

/** Collapses all whitespace runs to single spaces and trims the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Normalizes screen or stream text so the ready line can be found in it. */
function normalize(text: string): string {
  return collapseWhitespace(stripAnsi(text).replace(NOISE, ' '))
}

/**
 * True when the text contains the check-in line: the words DESKMATES, READY and
 * the phrase, in that order, separated only by whitespace, case-insensitive.
 * ANSI escape codes, box-drawing characters and markdown decoration are
 * stripped first, so a terminal's frame around the line doesn't hide it.
 */
export function isReadyLine(text: string, phrase: string): boolean {
  const normalized = normalize(text)
  const pattern = new RegExp(`\\bDESKMATES\\s+READY\\s+${escapeRegExp(phrase.trim())}\\b`, 'i')
  return pattern.test(normalized)
}

/** True when the user started a fresh conversation in the agent (/new, /clear, /reset). */
export function isContextReset(userInput: string): boolean {
  return /^\/(new|clear|reset)(\s|$)/i.test(userInput.trim())
}

export type OnboardingState = 'unknown' | 'primed' | 'confirmed' | 'failed'

interface Session {
  state: OnboardingState
  guideVersion: string
  primedAt: number
}

/**
 * Tracks the check-in for each connected agent session. A session key names one
 * connection to one agent (for example the agent id plus its conversation id).
 */
export class OnboardingTracker {
  private readonly sessions = new Map<string, Session>()
  private readonly timeoutMs: number

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 90_000
  }

  /**
   * True when the session needs the primer: it has never been primed, it
   * failed its check-in, or it was primed against a different guide version.
   */
  needsPrimer(sessionKey: string, guideVersion: string): boolean {
    const session = this.sessions.get(sessionKey)
    if (!session) return true
    if (session.state === 'failed' || session.state === 'unknown') return true
    return session.guideVersion !== guideVersion
  }

  /** Records that the primer was sent for this guide version at time `now`. */
  markPrimed(sessionKey: string, guideVersion: string, now: number): void {
    this.sessions.set(sessionKey, { state: 'primed', guideVersion, primedAt: now })
  }

  /**
   * Feeds text observed from the agent into the session. While primed, the
   * ready line confirms the check-in; once the timeout has passed without it,
   * the session fails. Anything else returns the current state.
   */
  observe(sessionKey: string, text: string, phrase: string, now: number): OnboardingState {
    const session = this.sessions.get(sessionKey)
    if (!session || session.state !== 'primed') return session?.state ?? 'unknown'
    if (isReadyLine(text, phrase)) {
      session.state = 'confirmed'
      return session.state
    }
    if (now - session.primedAt > this.timeoutMs) {
      session.state = 'failed'
      return session.state
    }
    return session.state
  }

  /** A context reset returns the session to unknown, so it gets primed again. */
  noteUserInput(sessionKey: string, text: string): void {
    if (!isContextReset(text)) return
    const session = this.sessions.get(sessionKey)
    if (session) session.state = 'unknown'
  }

  /** Forgets the session, for example when the agent disconnects. */
  disconnect(sessionKey: string): void {
    this.sessions.delete(sessionKey)
  }

  state(sessionKey: string): OnboardingState {
    return this.sessions.get(sessionKey)?.state ?? 'unknown'
  }
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
