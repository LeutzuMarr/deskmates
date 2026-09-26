import { join } from 'node:path'

/** The WSL distro every bot PC container runs inside. */
export const DISTRO = 'deskmates-engine'

/** The program every command in this module runs through. */
export const WSL_EXE = 'wsl.exe'

/** Fixed name of the one container used in `shared` PC mode. */
export const SHARED_CONTAINER_NAME = 'deskmates-shared'

/** Host-side (127.0.0.1) base ports; the actual port is `base + slot`. */
export const AGENT_BASE_PORT = 8700
export const NOVNC_BASE_PORT = 6900
export const CDP_BASE_PORT = 9220

/** Ports the bot-image service listens on inside the container (fixed, never shifted). */
export const AGENT_CONTAINER_PORT = 8700
export const NOVNC_CONTAINER_PORT = 6900
export const CDP_CONTAINER_PORT = 9222

/** Wraps a `docker` argument list so it runs inside the engine distro. */
export function dockerArgs(args: string[]): string[] {
  return ['-d', DISTRO, '--', 'docker', ...args]
}

/**
 * Makes sure dockerd is up inside the engine distro, starting it and waiting (bounded) if it isn't.
 * Needed because WSL stops an idle distro, and right after it boots again `/etc/wsl.conf`'s
 * `service docker start` is still in flight, so an immediate `docker` command fails. On failure it
 * prints the same phrases real docker does, so `classifyDockerError` and `EngineManager` read it as
 * "not installed" or "not running".
 */
export const START_DOCKER_SCRIPT = [
  "command -v docker >/dev/null 2>&1 || { echo 'docker: command not found' >&2; exit 127; }",
  'docker info >/dev/null 2>&1 && exit 0',
  'service docker start >/dev/null 2>&1',
  'i=0',
  'while [ $i -lt 30 ]; do docker info >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 1; done',
  "echo 'Cannot connect to the Docker daemon: it did not start within 30 seconds.' >&2",
  'exit 1'
].join('\n')

/** Runs `START_DOCKER_SCRIPT` inside the engine distro, as root since it may need to start a service. */
export function startDockerArgs(distro: string = DISTRO): string[] {
  return ['-d', distro, '-u', 'root', '--', 'sh', '-c', START_DOCKER_SCRIPT]
}

/** The container name for a bot's own PC. */
export function ownContainerName(botId: string): string {
  return `deskmates-bot-${botId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`
}

/**
 * The isolated Docker network created for one container, so containers can't reach each other's
 * agent/CDP/VNC ports — only `/shared` is a deliberate crossover between bots. Same lifecycle as
 * the container it's named after: `LocalWslHost.runContainer` creates it right before `docker run`
 * and attaches the container with `--network`; `reset`/`delete` remove it after removing the
 * container. Derived from the container name (rather than the raw botId) so it works unchanged
 * for the shared PC's container too, which has no botId of its own.
 */
export function networkNameFor(containerName: string): string {
  return `${containerName}-net`
}

/** Where a PC's `/home/bot/data` is stored on Windows. `pcId` is a botId, or the shared PC's id. */
export function pcStorageDir(dataDir: string, pcId: string): string {
  return join(dataDir, 'pcs', pcId)
}

/** Where the folder every PC sees at `/shared` is stored on Windows. */
export function sharedDir(dataDir: string): string {
  return join(dataDir, 'shared')
}

/**
 * Converts a Windows path (`D:\Data\x`) to the form the WSL distro sees for that drive
 * (`/mnt/d/Data/x`), so it can be used in a `docker -v`/`docker cp` argument. A path that's
 * already POSIX-shaped is returned unchanged.
 */
export function toWslPath(winPath: string): string {
  const posix = winPath.replace(/\\/g, '/')
  const match = /^([A-Za-z]):\/(.*)$/.exec(posix)
  if (!match) return posix
  const [, drive, rest] = match
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

export interface PcPorts {
  agent: number
  novnc: number
  cdp: number
}

/** The host-side port block for a PC's slot. */
export function portsFor(slot: number): PcPorts {
  return { agent: AGENT_BASE_PORT + slot, novnc: NOVNC_BASE_PORT + slot, cdp: CDP_BASE_PORT + slot }
}
