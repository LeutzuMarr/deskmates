import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { guide, designList, designPath, designRead, designWrite, designCreate, pcList, pcExec, pcOpen, pcScreenshot, type Call } from './actions'
import { connectCore, NotRunningError, type CoreClient } from './client'
import { PcNotSetUpError } from './actions'
import { runMcpServerOnStdio } from './mcp'

export const EXIT_OK = 0
export const EXIT_USAGE = 1
export const EXIT_NOT_RUNNING = 2
export const EXIT_CORE_ERROR = 3

/** Everything main needs from the world, so tests can run it with fakes. */
export interface CliDeps {
  connectCore(options: { dataDir: string }): Promise<CoreClient>
  /** Prints a normal output line (stdout). */
  log(text: string): void
  /** Prints an error line (stderr). */
  error(text: string): void
}

const USAGE = `Usage: deskmates <command> [--json] [--data-dir <path>]

Commands:
  guide                                  print the agent guide
  design list                            list the designs
  design path <id>                       print a design's index.html path
  design read <id>                       print a design's HTML
  design write <id> <file>               replace a design's HTML (- reads stdin)
  design create "<name>" [--prompt "t"]  make a new design
  pc list                                list the bot PCs
  pc exec <pc> -- <command>              run a command on a bot PC
  pc open <pc> <url>                     open a page on a bot PC
  pc screenshot <pc> <out.png>           screenshot a bot PC
  mcp                                    run the MCP server on stdio
  help                                   show this help

Exit codes: 0 ok, 1 usage error, 2 Deskmates isn't running, 3 core error.
The data folder comes from DESKMATES_DATA_DIR or --data-dir.`

interface ParsedArgs {
  dataDir: string | null
  json: boolean
  rest: string[]
}

/** Splits off the global flags and keeps the positional words in order. */
function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = []
  let dataDir: string | null = null
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--data-dir') {
      dataDir = argv[++i] ?? null
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length)
    } else {
      rest.push(arg)
    }
  }
  return { dataDir, json, rest }
}
/** Prints a result: pretty JSON in JSON mode, human text otherwise. */
function emitText(deps: CliDeps, json: boolean, value: unknown, text: string): void {
  if (json) deps.log(JSON.stringify(value, null, 2))
  else deps.log(text)
}

/**
 * Runs one deskmates command and returns the process exit code:
 * 0 ok, 1 usage error, 2 not running, 3 core error.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv)
  const [command, sub, ...rest] = parsed.rest

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    deps.log(USAGE)
    return EXIT_OK
  }

  const dataDir = resolveDataDir(parsed)
  if (!dataDir) {
    deps.error('No data folder given. Set DESKMATES_DATA_DIR or pass --data-dir <path>.')
    return EXIT_USAGE
  }

  try {
    if (command === 'guide') return cmdGuide(dataDir, deps)
    if (command === 'design') return await cmdDesign(deps, parsed, sub, rest)
    if (command === 'pc') return await cmdPc(deps, parsed, sub, rest)
    if (command === 'mcp') return await cmdMcp(deps, dataDir)
    deps.error(`Unknown command: ${command}. Run deskmates help for the list.`)
    return EXIT_USAGE
  } catch (error) {
    if (error instanceof NotRunningError) {
      deps.error(error.message)
      return EXIT_NOT_RUNNING
    }
    deps.error(error instanceof Error ? error.message : String(error))
    return EXIT_CORE_ERROR
  }
}

/** design list | path | read | write | create. */
async function cmdDesign(deps: CliDeps, parsed: ParsedArgs, sub: string | undefined, rest: string[]): Promise<number> {
  if (!sub) {
    deps.error('Missing design subcommand. Run deskmates help.')
    return EXIT_USAGE
  }
  if (sub === 'list') {
    return await withClient(deps, parsed, async (call) => {
      const designs = await designList(call)
      const text = designs.length === 0 ? 'No designs yet.' : designs.map((d) => `${d.id}\t${d.name}\t${d.folder}`).join('\n')
      emitText(deps, parsed.json, designs, text)
      return EXIT_OK
    })
  }
  const id = rest[0]
  if (!id) {
    deps.error(`design ${sub} needs an id.`)
    return EXIT_USAGE
  }
  return await withClient(deps, parsed, async (call) => {
    if (sub === 'path') {
      const path = await designPath(call, id)
      emitText(deps, parsed.json, { path }, path)
      return EXIT_OK
    }
    if (sub === 'read') {
      const read = await designRead(call, id)
      emitText(deps, parsed.json, read, read.html)
      return EXIT_OK
    }
    if (sub === 'write') {
      const file = rest[1]
      if (!file) {
        deps.error('design write needs a file (- reads stdin).')
        return EXIT_USAGE
      }
      const html = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
      const saved = await designWrite(call, id, html)
      emitText(deps, parsed.json, saved, `Saved. The preview reloads by itself.`)
      return EXIT_OK
    }
    if (sub === 'create') {
      const prompt = takeFlag(rest, '--prompt')
      const created = await designCreate(call, id, prompt)
      const text = `Created "${created.project.name}" (${created.project.id}).`
      emitText(deps, parsed.json, { project: created.project, taskId: created.task.id }, text)
      return EXIT_OK
    }
    deps.error(`Unknown design subcommand: ${sub}.`)
    return EXIT_USAGE
  })
}

/** pc list | exec | open | screenshot — stubs until the bot engine lands (stage 2). */
async function cmdPc(deps: CliDeps, parsed: ParsedArgs, sub: string | undefined, rest: string[]): Promise<number> {
  if (sub !== 'list' && sub !== 'exec' && sub !== 'open' && sub !== 'screenshot') {
    deps.error('Missing or unknown pc subcommand. Run deskmates help.')
    return EXIT_USAGE
  }
  return await withClient(deps, parsed, async (call) => {
    if (sub === 'list') await pcList(call)
    else if (sub === 'exec') {
      const [pcWords, commandWords] = splitOnDoubleDash(rest)
      const pc = pcWords[0]
      if (!pc || commandWords.length === 0) {
        deps.error('pc exec needs a pc and a command: pc exec <pc> -- <command>.')
        return EXIT_USAGE
      }
      await pcExec(call, pc, commandWords.join(' '))
    } else if (sub === 'open') {
      const [pc, url] = rest
      if (!pc || !url) {
        deps.error('pc open needs a pc and a url.')
        return EXIT_USAGE
      }
      await pcOpen(call, pc, url)
    } else {
      const [pc, out] = rest
      if (!pc || !out) {
        deps.error('pc screenshot needs a pc and an output file.')
        return EXIT_USAGE
      }
      await pcScreenshot(call, pc, out)
    }
    return EXIT_OK
  })
}

/** Splits ['pc', '--', 'git', 'status'] into ['pc'] and ['git', 'status']. */
function splitOnDoubleDash(args: string[]): string[][] {
  const index = args.indexOf('--')
  if (index === -1) return [args]
  return [args.slice(0, index), args.slice(index + 1)]
}

/** Pulls the value of a flag like --prompt out of the argument list. */
function takeFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Connects, runs the body with the client, always closes it. */
async function withClient(deps: CliDeps, parsed: ParsedArgs, run: (call: Call) => Promise<number>): Promise<number> {
  const client = await deps.connectCore({ dataDir: resolveDataDir(parsed) })
  try {
    return await run((method, params) => client.call(method, params))
  } finally {
    client.close()
  }
}

/** mcp: runs the MCP server on stdio. Stdout belongs to the protocol, so the
 * connecting message goes to stderr, and the command stays alive until the
 * client disconnects. */
async function cmdMcp(deps: CliDeps, dataDir: string): Promise<number> {
  const client = await deps.connectCore({ dataDir })
  try {
    deps.error('Deskmates MCP server listening on stdio.')
    await runMcpServerOnStdio({ call: (method, params) => client.call(method, params), dataDir })
    return EXIT_OK
  } finally {
    client.close()
  }
}

/** guide: prints the guide file; a missing file means the app hasn't run yet. */
function cmdGuide(dataDir: string, deps: CliDeps): number {
  try {
    deps.log(guide(dataDir))
    return EXIT_OK
  } catch {
    throw new NotRunningError()
  }
}


/** Resolves the data folder: DESKMATES_DATA_DIR, then --data-dir. */
function resolveDataDir(parsed: ParsedArgs): string {
  return parsed.dataDir ?? process.env.DESKMATES_DATA_DIR ?? ''
}

// Runs only when this module is the process's entry point (node cli.js ... or the deskmates.cmd
// wrapper), not when tests import `main` and drive it with fake deps.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2), {
    connectCore,
    log: (text) => console.log(text),
    error: (text) => console.error(text)
  }).then((code) => {
    process.exitCode = code
  })
}
