import { join } from 'node:path'

/**
 * Whether bot PCs run inside a purpose-built WSL distro (Windows) or directly on the host's own
 * Docker daemon (Linux and macOS).
 *
 * The bot PC image itself is plain Linux and identical either way, and every `docker` flag this app
 * passes is stock — so the only real difference is *how the CLI is reached*. Windows routes it
 * through `wsl.exe -d deskmates-engine --` because that distro isolates the containers from whatever
 * else the user runs; everywhere else Docker is already a service, and the isolation comes from the
 * per-container network and bind mounts instead. That makes this flag, plus the two functions below,
 * the entire difference between the platforms.
 */
export const USES_WSL = process.platform === 'win32'

/** The WSL distro every bot PC container runs inside (Windows only; ignored elsewhere). */
export const DISTRO = 'deskmates-engine'

/** The WSL launcher itself, for the two places that talk to WSL as WSL rather than to Docker
 *  through it: the engine's own setup checks, and the keep-alive that holds the distro open.
 *  Always spelled in full so Windows never resolves it through a shell or PATHEXT search. */
export const WSL_EXE = 'wsl.exe'

/**
 * The program every docker command in this module is run through: `wsl.exe` on Windows, the `docker`
 * binary itself everywhere else.
 */
export const DOCKER_PROGRAM = USES_WSL ? 'wsl.exe' : 'docker'

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

/** Wraps a `docker` argument list so it reaches the engine on either platform. */
export function dockerArgs(args: string[]): string[] {
  return USES_WSL ? ['-d', DISTRO, '--', 'docker', ...args] : args
}

/**
 * Makes sure dockerd is up inside the engine distro, starting it and waiting (bounded) if it isn't.
 * Needed because WSL stops an idle distro, and right after it boots again `/etc/wsl.conf`'s
 * `service docker start` is still in flight, so an immediate `docker` command fails. On failure it
 * prints the same phrases real docker does, so `classifyDockerError` and `EngineManager` read it as
 * "not installed" or "not running".
 *
 * Windows-only, and deliberately so. Off Windows the host's Docker is a system service this app has
 * no business restarting from a desktop process — doing it would mean a `sudo` prompt (or worse, a
 * polkit agent) on a normal user action. There, `docker info` is used purely as a health probe and
 * the daemon is expected to already be running.
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
 * the container it's named after: `LocalDockerHost.runContainer` creates it right before `docker run`
 * and attaches the container with `--network`; `reset`/`delete` remove it after removing the
 * container. Derived from the container name (rather than the raw botId) so it works unchanged
 * for the shared PC's container too, which has no botId of its own.
 */
export function networkNameFor(containerName: string): string {
  return `${containerName}-net`
}

/** Where a PC's `/home/bot/data` is stored on the host. `pcId` is a botId, or the shared PC's id. */
export function pcStorageDir(dataDir: string, pcId: string): string {
  return join(dataDir, 'pcs', pcId)
}

/** Where the folder every PC sees at `/shared` is stored on the host. */
export function sharedDir(dataDir: string): string {
  return join(dataDir, 'shared')
}

/**
 * Puts a host path in the form Docker will accept in a `-v` or `docker cp` argument.
 *
 * On Linux and macOS the path is already what Docker wants, so this only normalizes separators and
 * returns it. On Windows the host is `D:\Data\x` while the engine sees the drive through WSL's
 * mount point (`/mnt/d/Data/x`), so that translation is what actually happens there.
 */
export function toDockerPath(hostPath: string): string {
  const posix = hostPath.replace(/\\/g, '/')
  if (!USES_WSL) return posix
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
