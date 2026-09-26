/** Saves a screenshot's PNG bytes into the run's folder and returns where it landed. Shared by the browser and screen tools. */
export type SaveScreenshot = (png: Buffer, label: string) => Promise<{ path: string; bytes: number }>

/** Node's `fetch` only says "fetch failed"; what actually happened (ECONNREFUSED, ECONNRESET, …) is on `cause`, or on the error itself for a WebSocket. */
function describeConnectionFailure(error: unknown): string {
  const codeOf = (value: unknown): string | undefined => {
    const code = (value as { code?: unknown } | null | undefined)?.code
    return typeof code === 'string' ? code : undefined
  }
  const code = codeOf((error as { cause?: unknown } | null | undefined)?.cause) ?? codeOf(error)
  if (code === 'ECONNREFUSED') return 'nothing is answering on its port'
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return 'the connection was dropped'
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'the connection timed out'
  if (code) return code
  return error instanceof Error ? error.message : String(error)
}

/**
 * The bot's PC (its agent service or its browser) couldn't be reached at all, as opposed to answering
 * with an error. The run loop treats this as "the PC went away": it brings the PC back up and retries
 * the tool once (see `guardPcTools` in `runner.ts`). Never includes the agent token.
 */
export class PcUnreachableError extends Error {
  constructor(what: 'PC' | 'browser', error: unknown) {
    super(`Couldn't reach the bot's ${what} (${describeConnectionFailure(error)}). Its PC may have stopped or still be starting.`)
    this.name = 'PcUnreachableError'
  }
}
