import type { CommandResult } from './command-runner'
import { BotHostError, type BotHostErrorCode } from './host'

interface Match {
  code: BotHostErrorCode
  message: string
}

/**
 * Recognizes the docker/wsl failures this module needs to turn into plain sentences. Returns
 * `null` for anything it doesn't recognize, so callers that don't want to treat every non-zero
 * exit as a host failure (see `exec` in `local-wsl-host.ts`) can tell "docker itself failed"
 * apart from "the command inside the container exited non-zero".
 */
function matchDockerError(text: string): Match | null {
  const s = text.toLowerCase()

  if (
    s.includes('cannot connect to the docker daemon') ||
    s.includes('error during connect') ||
    s.includes('there is no distribution with the supplied name') ||
    s.includes('wsl_e_distro_not_found') ||
    s.includes("'docker' is not recognized") ||
    s.includes('docker: command not found')
  ) {
    return {
      code: 'engine-not-running',
      message: "The Deskmates engine isn't running. Open the setup wizard to start it."
    }
  }

  if (
    s.includes('no such image') ||
    s.includes('pull access denied') ||
    s.includes('manifest unknown') ||
    s.includes('repository does not exist')
  ) {
    return {
      code: 'image-missing',
      message: "This bot's PC image isn't installed yet. Download or build it from Settings."
    }
  }

  if (
    s.includes('port is already allocated') ||
    s.includes('address already in use') ||
    /bind for [^\n]* failed/.test(s)
  ) {
    return {
      code: 'port-taken',
      message: "Another program is already using this bot's PC ports. Close it and try again."
    }
  }

  // Checked before the generic "is not running" below: a missing container also isn't running.
  if (s.includes('no such container')) {
    return { code: 'not-created', message: "This bot's PC hasn't been created yet." }
  }

  if (s.includes('is not running')) {
    return { code: 'not-running', message: "This bot's PC isn't running right now." }
  }

  return null
}

/** Whether `result` (a non-zero exit) looks like docker/wsl itself failing, rather than a command inside the container exiting non-zero. */
export function isKnownDockerFailure(result: CommandResult): boolean {
  return matchDockerError(`${result.stderr}\n${result.stdout}`) !== null
}

/** Turns a failed docker/wsl command into a `BotHostError`, with the raw stderr kept as `cause`. */
export function classifyDockerError(result: CommandResult): BotHostError {
  const match = matchDockerError(`${result.stderr}\n${result.stdout}`) ?? {
    code: 'unknown' as const,
    message: "Something went wrong talking to this bot's PC."
  }
  return new BotHostError(match.code, match.message, result.stderr)
}
