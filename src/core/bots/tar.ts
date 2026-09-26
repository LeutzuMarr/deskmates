import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** Size in bytes of one uStar header block; payloads are padded up to a multiple of this. */
const BLOCK = 512

/** An entry scheduled for serialization; `name` is relative to the archive root, which is the basename of the tarred path. */
interface PendingEntry {
  name: string
  isDir: boolean
  mode: number
  mtimeSeconds: number
  content?: Buffer
}

/** Writes an octal field as zero-padded digits terminated by a NUL, the layout every uStar numeric field uses. */
function writeOctal(buf: Buffer, offset: number, value: number, digits: number): void {
  const oct = value.toString(8)
  if (oct.length > digits - 1) {
    throw new Error(`Octal value ${value} does not fit in ${digits - 1} digits`)
  }
  buf.write(oct.padStart(digits - 1, '0') + '\u0000', offset, 'ascii')
}

/** Unix seconds for an mtime, clamped to 0 when the filesystem did not provide one. */
function mtimeSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
}

/** File mode: 0755 for executable files, 0644 otherwise. */
function fileMode(statMode: number): number {
  return (statMode & 0o111) !== 0 ? 0o755 : 0o644
}

/** Serializes one 512-byte header with a checksum computed over the header with the checksum field treated as 8 spaces. */
function serializeHeader(entry: PendingEntry): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.fill(0)
  Buffer.from(entry.name, 'utf8').copy(header, 0)
  writeOctal(header, 100, entry.mode, 8)
  writeOctal(header, 108, 0, 8)
  writeOctal(header, 116, 0, 8)
  writeOctal(header, 124, entry.content ? entry.content.length : 0, 12)
  writeOctal(header, 136, entry.mtimeSeconds, 12)
  header.write('        ', 148, 'ascii')
  header.write(entry.isDir ? '5' : '0', 156, 'ascii')
  header.write('ustar\u0000', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/** Collects every entry under `dirPath`, one header per directory, in sorted order so runs are byte-identical. */
async function collectDir(dirPath: string, prefix: string, entries: PendingEntry[]): Promise<void> {
  const items = await readdir(dirPath, { withFileTypes: true })
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const item of items) {
    const entryPath = join(dirPath, item.name)
    const st = await lstat(entryPath)
    if (st.isSymbolicLink()) throw new Error(`Refusing to tar symlink "${entryPath}"`)
    const name = `${prefix}/${item.name}`
    if (st.isDirectory()) {
      entries.push({ name, isDir: true, mode: 0o755, mtimeSeconds: mtimeSeconds(st.mtimeMs) })
      await collectDir(entryPath, name, entries)
    } else if (st.isFile()) {
      const content = await readFile(entryPath)
      entries.push({ name, isDir: false, mode: fileMode(st.mode), mtimeSeconds: mtimeSeconds(st.mtimeMs), content })
    } else {
      throw new Error(`Cannot tar "${entryPath}": not a regular file or directory`)
    }
  }
}

/**
 * Creates a uStar tar archive of `path` (a file or a folder) suitable for Docker's
 * copy-in endpoint: the archive root entry is the basename of `path`, matching how
 * `docker cp <path> container:<dest>` behaves.
 */
export async function createTar(path: string): Promise<Buffer> {
  const rootStat = await lstat(path)
  if (rootStat.isSymbolicLink()) throw new Error(`Refusing to tar symlink "${path}"`)
  const rootName = basename(path)
  const entries: PendingEntry[] = []
  if (rootStat.isDirectory()) {
    entries.push({ name: rootName, isDir: true, mode: 0o755, mtimeSeconds: mtimeSeconds(rootStat.mtimeMs) })
    await collectDir(path, rootName, entries)
  } else if (rootStat.isFile()) {
    const content = await readFile(path)
    entries.push({
      name: rootName,
      isDir: false,
      mode: fileMode(rootStat.mode),
      mtimeSeconds: mtimeSeconds(rootStat.mtimeMs),
      content
    })
  } else {
    throw new Error(`Cannot tar "${path}": not a regular file or directory`)
  }

  const chunks: Buffer[] = []
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name, 'utf8') > 100) {
      throw new Error(`Cannot tar entry "${entry.name}": name exceeds the 100-byte uStar limit`)
    }
    chunks.push(serializeHeader(entry))
    if (entry.content) {
      chunks.push(entry.content)
      const pad = (BLOCK - (entry.content.length % BLOCK)) % BLOCK
      if (pad > 0) chunks.push(Buffer.alloc(pad))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

/** Rejects an entry name that could resolve outside `targetDir`; the error names the offending entry. */
function assertSafeName(name: string): void {
  if (name.startsWith('/')) throw new Error(`Refusing to extract tar entry "${name}": absolute path`)
  if (name.includes('\u0000')) throw new Error(`Refusing to extract tar entry "${name}": contains a NUL byte`)
  if (name.includes('\\')) throw new Error(`Refusing to extract tar entry "${name}": backslash in entry name`)
  for (const segment of name.split('/')) {
    if (segment === '..') throw new Error(`Refusing to extract tar entry "${name}": parent-directory traversal`)
  }
}

/**
 * Extracts a uStar tar archive into `targetDir` (created if missing). Returns the number of entries extracted.
 */
export async function extractTar(tar: Buffer, targetDir: string): Promise<number> {
  interface Entry {
    name: string
    typeflag: string
    size: number
    dataStart: number
  }

  const entries: Entry[] = []
  let offset = 0
  while (offset < tar.length) {
    if (tar.length - offset < BLOCK) {
      throw new Error(`Truncated tar: a header block at offset ${offset} is not 512-byte aligned`)
    }
    const block = tar.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const nameEnd = block.indexOf(0)
    const name = block.subarray(0, nameEnd === -1 ? 100 : nameEnd).toString('utf8')
    assertSafeName(name)
    const typeflag = String.fromCharCode(block[156])
    if (typeflag !== '0' && typeflag !== '5') {
      throw new Error(`Refusing to extract tar entry "${name}": unsupported type flag '${typeflag}'`)
    }
    const size = parseInt(block.subarray(124, 136).toString('ascii'), 8)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Refusing to extract tar entry "${name}": malformed size field`)
    }
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (offset + BLOCK + padded > tar.length) {
      throw new Error(`Truncated tar: the payload of entry "${name}" runs past the end of the archive`)
    }
    entries.push({ name, typeflag, size, dataStart: offset + BLOCK })
    offset += BLOCK + padded
  }

  await mkdir(targetDir, { recursive: true })
  let extracted = 0
  for (const entry of entries) {
    const dest = resolve(targetDir, entry.name)
    if (entry.typeflag === '5') {
      await mkdir(dest, { recursive: true })
    } else {
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, tar.subarray(entry.dataStart, entry.dataStart + entry.size))
    }
    extracted++
  }
  return extracted
}