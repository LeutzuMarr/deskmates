import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTar, extractTar } from '../../src/core/bots/tar'

/** Writes a numeric field the way uStar formats it: zero-padded octal plus a terminating NUL. */
function writeOctal(buf: Buffer, offset: number, value: number, digits: number): void {
  buf.write(value.toString(8).padStart(digits - 1, '0') + '\u0000', offset, 'ascii')
}

/** Builds a single-entry 512-byte header carrying a self-consistent checksum. */
function entryHeader(name: string, typeflag: string, payload?: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.fill(0)
  header.write(name, 0, 'utf8')
  writeOctal(header, 100, 0o644, 8)
  writeOctal(header, 108, 0, 8)
  writeOctal(header, 116, 0, 8)
  writeOctal(header, 124, payload ? payload.length : 0, 12)
  writeOctal(header, 136, 0, 12)
  header.write('        ', 148, 'ascii')
  header.write(typeflag, 156, 'ascii')
  header.write('ustar\u0000', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

/** Assembles a full archive: header blocks, NUL-padded payloads, and the two terminating NUL blocks. */
function archiveWith(entries: Array<{ name: string; typeflag: string; payload?: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    chunks.push(entryHeader(entry.name, entry.typeflag, entry.payload))
    if (entry.payload) {
      chunks.push(entry.payload)
      const pad = (512 - (entry.payload.length % 512)) % 512
      if (pad > 0) chunks.push(Buffer.alloc(pad))
    }
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

/** The checksum a header would need for consistency, with the checksum field credited as 8 spaces. */
function computedChecksum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < header.length; i++) {
    sum += i >= 148 && i <= 155 ? 0x20 : header[i]
  }
  return sum
}

describe('BotHost tar (uStar)', () => {
  let base: string

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'deskmates-tar-')))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('1. round-trips a folder: nested dirs, files, and multibyte content with identical bytes and structure', async () => {
    const src = join(base, 'src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'sub', 'nested.txt'), 'héllo wörld 🌍\n日本語', 'utf8')
    writeFileSync(join(src, 'top.txt'), 'top-level file', 'utf8')

    const count = await extractTar(await createTar(src), join(base, 'dst'))

    expect(count).toBe(4)
    const dst = join(base, 'dst')
    expect(statSync(join(dst, 'src')).isDirectory()).toBe(true)
    expect(statSync(join(dst, 'src', 'sub')).isDirectory()).toBe(true)
    expect(readFileSync(join(dst, 'src', 'top.txt'))).toEqual(readFileSync(join(src, 'top.txt')))
    expect(readFileSync(join(dst, 'src', 'sub', 'nested.txt'))).toEqual(readFileSync(join(src, 'sub', 'nested.txt')))
  })

  it('2. tars a single file and extracts it under its basename in the target', async () => {
    const file = join(base, 'single.bin')
    writeFileSync(file, Buffer.from([0, 1, 2, 255, 128, 42]))

    const dst = join(base, 'dst')
    const count = await extractTar(await createTar(file), dst)

    expect(count).toBe(1)
    expect(readFileSync(join(dst, 'single.bin'))).toEqual(readFileSync(file))
  })

  it('3. is deterministic: two runs over the same tree are byte-identical and end in the two NUL blocks', async () => {
    const tree = join(base, 'tree')
    mkdirSync(join(tree, 'a', 'deep'), { recursive: true })
    writeFileSync(join(tree, 'a', 'b.txt'), 'bees')
    writeFileSync(join(tree, 'a', 'deep', 'c.txt'), 'sea')
    writeFileSync(join(tree, 'top.md'), '# hi')

    const first = await createTar(tree)
    const second = await createTar(tree)

    expect(first.equals(second)).toBe(true)
    let trailing = 0
    for (let i = first.length - 1; i >= 0 && first[i] === 0; i--) trailing++
    expect(trailing).toBeGreaterThanOrEqual(1024)
    expect(trailing).toBeLessThan(2048)
  })

  it('4. createTar rejects a symlink instead of following it', async () => {
    mkdirSync(join(base, 'real'))
    writeFileSync(join(base, 'real', 'kept.txt'), 'kept')
    let link: string
    try {
      link = join(base, 'link')
      symlinkSync(join(base, 'real'), link, 'dir')
    } catch {
      return
    }
    await expect(createTar(link)).rejects.toThrow(/symlink/i)
  })

  const malicious = [
    { name: '../evil', label: 'parent traversal' },
    { name: '/abs', label: 'absolute path' },
    { name: 'a/../../evil', label: 'deep parent traversal' },
    { name: 'a/..\\evil', label: 'backslash separator' }
  ]

  it.each(malicious)('5. refuses entry "$name" ($label) and writes nothing', async ({ name }) => {
    const target = join(base, 'target')
    await expect(extractTar(archiveWith([{ name, typeflag: '0' }]), target)).rejects.toThrow(/Refusing to extract/)
    expect(existsSync(target)).toBe(false)
  })

  it('6. refuses a symlink typeflag and writes nothing', async () => {
    const target = join(base, 'target')
    await expect(extractTar(archiveWith([{ name: 'link', typeflag: '2' }]), target)).rejects.toThrow(
      /unsupported type flag/
    )
    expect(existsSync(target)).toBe(false)
  })

  it('7. refuses a truncated archive and writes nothing', async () => {
    const src = join(base, 'src')
    mkdirSync(join(src, 'empty'), { recursive: true })
    writeFileSync(join(src, 'big.bin'), Buffer.alloc(600, 0x41))
    writeFileSync(join(src, 'small.txt'), 'tiny', 'utf8')

    const tar = await createTar(src)
    const half = tar.subarray(0, Math.floor(tar.length / 2))
    const target = join(base, 'target')
    await expect(extractTar(half, target)).rejects.toThrow(/Truncated tar/)
    expect(existsSync(target)).toBe(false)

    const midHeader = tar.subarray(0, 512 + 256)
    const otherTarget = join(base, 'other-target')
    await expect(extractTar(midHeader, otherTarget)).rejects.toThrow(/Truncated tar/)
    expect(existsSync(otherTarget)).toBe(false)
  })

  it('8. hand-built header: nested path preserved, payload round-trips, checksum field is internally consistent', async () => {
    const payload = Buffer.from('round trip ✓ 日本語', 'utf8')
    const tar = archiveWith([{ name: 'sub/hello.txt', typeflag: '0', payload }])
    const header = tar.subarray(0, 512)

    const nameEnd = header.indexOf(0)
    const name = header.subarray(0, nameEnd === -1 ? 100 : nameEnd).toString('utf8')
    expect(name).toBe('sub/hello.txt')
    expect(header[156]).toBe(0x30)
    expect(parseInt(header.subarray(148, 156).toString('ascii'), 8)).toBe(computedChecksum(header))

    const target = join(base, 'target')
    expect(await extractTar(tar, target)).toBe(1)
    expect(statSync(join(target, 'sub')).isDirectory()).toBe(true)
    expect(readFileSync(join(target, 'sub', 'hello.txt'))).toEqual(payload)
  })
})