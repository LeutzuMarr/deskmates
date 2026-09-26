import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Where to get the Linux root filesystem imported as the `deskmates-engine` WSL distro, and its expected hash. */
export interface RootfsSource {
  url: string
  sha256: string
  /** File name used to cache the download under `<dataDir>/engine/downloads`. */
  filename: string
}

/**
 * Debian `bookworm`, amd64, built by debuerreotype (the same reproducible-build project Docker's
 * official `debian` images come from) — https://github.com/debuerreotype/docker-debian-artifacts,
 * branch `dist-amd64`, folder `bookworm`. That project rebuilds monthly for security updates, so
 * this hash will need bumping periodically; `setup()` always verifies it against the download.
 *
 * This used to point at a plain `bookworm/rootfs.tar.xz`, which the project stopped publishing
 * (confirmed 2026-09-21: that path 404s). `download.sh` in that repo now deletes `rootfs.tar.xz`
 * after unpacking it into an OCI layout and instead ships `bookworm/oci/blobs/rootfs.tar.gz` — a
 * gzipped tar, content-addressed by its own sha256, which is also its symlinked name under
 * `oci/blobs/sha256/<digest>`. `wsl --import` accepts a gzip-compressed tar directly, so this
 * points at that blob instead; the hash below was computed from the real download, not copied
 * from the repo's own (still-`rootfs.tar.xz`-named) `rootfs.tar.xz.sha256` file.
 */
export const DEBIAN_ROOTFS: RootfsSource = {
  url: 'https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/bookworm/oci/blobs/rootfs.tar.gz',
  sha256: 'eaac70c68abdf6ffacf6de10d31ed9de4813505d1a794eb7393cb27fceb624a6',
  filename: 'debian-bookworm-amd64-rootfs.tar.gz'
}

/** Fetches a URL to a local file. Injectable so tests never touch the network. */
export interface Downloader {
  download(url: string, destPath: string): Promise<void>
}

/** The real downloader, used outside tests. */
export class FetchDownloader implements Downloader {
  async download(url: string, destPath: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`.trim())
    }
    const { writeFile } = await import('node:fs/promises')
    const bytes = new Uint8Array(await response.arrayBuffer())
    await writeFile(destPath, bytes)
  }
}

/** SHA-256 of a file's contents, as lowercase hex. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
