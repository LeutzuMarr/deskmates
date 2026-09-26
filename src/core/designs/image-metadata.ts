import { inflateSync } from 'node:zlib'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg'

export interface ImageMetadata {
  format: ImageFormat
  /** Pixel size; null when the file doesn't state one (an SVG sized only in percent). */
  width: number | null
  height: number | null
  /** Whether the format can hold transparency at all. */
  formatSupportsTransparency: boolean
  /** Whether this file carries transparency information: an alpha channel, a transparent colour or index. */
  hasAlphaChannel: boolean
  /** Whether any pixel is actually see-through; null when that wasn't decoded. */
  hasTransparentPixels: boolean | null
  animated: boolean
  /** Frame count, for animated GIF, APNG and WebP. */
  frames?: number
  /** Format-specific extras: bit depth, colour type, interlacing, viewBox… */
  details: Record<string, string | number | boolean>
}

/** Decoding a PNG to look for transparent pixels stops above this many bytes of raw pixel data. */
const MAX_DECODED_BYTES = 256 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Identifies the image by its bytes (not its name) and reads its header. Throws for anything else. */
export function readImageMetadata(data: Buffer): ImageMetadata {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(data)
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return readJpeg(data)
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('latin1', 0, 6))) return readGif(data)
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return readWebp(data)
  }
  if (data.length >= 26 && data.toString('latin1', 0, 2) === 'BM') return readBmp(data)
  const head = data.subarray(0, 4096).toString('utf8')
  if (/<svg[\s>]/i.test(head) || /<svg[\s>]/i.test(data.toString('utf8'))) return readSvg(data.toString('utf8'))
  throw new Error('Not a supported image. Supported: PNG, JPEG, GIF, WebP, BMP and SVG.')
}

// ---------------------------------------------------------------- PNG

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const COLOR_TYPES: Record<number, string> = { 0: 'grayscale', 2: 'rgb', 3: 'palette', 4: 'grayscale+alpha', 6: 'rgba' }
/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
]

interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlaced: boolean
}

function readPng(data: Buffer): ImageMetadata {
  let header: PngHeader | null = null
  let trns: Buffer | null = null
  let frames: number | undefined
  const idat: Buffer[] = []
  let offset = 8
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, Math.min(data.length, offset + 8 + length))
    if (type === 'IHDR' && body.length >= 13) {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlaced: body[12] === 1
      }
    } else if (type === 'tRNS') trns = body
    else if (type === 'acTL' && body.length >= 4) frames = body.readUInt32BE(0)
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new Error('This PNG has no header (IHDR); the file may be damaged.')

  const { width, height, bitDepth, colorType, interlaced } = header
  const hasAlphaChannel = colorType === 4 || colorType === 6 || trns !== null
  let hasTransparentPixels: boolean | null = hasAlphaChannel ? null : false
  if (hasAlphaChannel) {
    try {
      hasTransparentPixels = pngHasTransparentPixels(header, Buffer.concat(idat), trns)
    } catch {
      hasTransparentPixels = null
    }
  }
  return {
    format: 'png',
    width,
    height,
    formatSupportsTransparency: true,
    hasAlphaChannel,
    hasTransparentPixels,
    animated: frames !== undefined && frames > 1,
    ...(frames !== undefined ? { frames } : {}),
    details: { bitDepth, colorType: COLOR_TYPES[colorType] ?? String(colorType), interlaced }
  }
}

/** Inflates and unfilters the image data and looks for a pixel that isn't fully opaque. Null when too large. */
function pngHasTransparentPixels(header: PngHeader, compressed: Buffer, trns: Buffer | null): boolean | null {
  const { width, height, bitDepth, colorType, interlaced } = header
  const channels = CHANNELS[colorType]
  if (!channels) return null
  const isTransparent = pixelTest(colorType, bitDepth, trns)
  if (!isTransparent) return null
  const bitsPerPixel = channels * bitDepth
  const rawSize = Math.ceil((width * bitsPerPixel) / 8 + 1) * height
  if (rawSize > MAX_DECODED_BYTES) return null
  const raw = inflateSync(compressed, { maxOutputLength: MAX_DECODED_BYTES + height })
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))

  const passes = interlaced
    ? ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)])
    : [[width, height]]
  let offset = 0
  for (const [passWidth, passHeight] of passes) {
    if (passWidth <= 0 || passHeight <= 0) continue
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8)
    let previous = Buffer.alloc(rowBytes)
    for (let y = 0; y < passHeight; y++) {
      if (offset + 1 + rowBytes > raw.length) return null
      const filter = raw[offset]
      const row = Buffer.from(raw.subarray(offset + 1, offset + 1 + rowBytes))
      unfilter(filter, row, previous, bpp)
      if (isTransparent(row, passWidth)) return true
      previous = row
      offset += 1 + rowBytes
    }
  }
  return false
}

function unfilter(filter: number, row: Buffer, previous: Buffer, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0
    const up = previous[i]
    const upLeft = i >= bpp ? previous[i - bpp] : 0
    let add = 0
    if (filter === 1) add = left
    else if (filter === 2) add = up
    else if (filter === 3) add = (left + up) >> 1
    else if (filter === 4) {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    row[i] = (row[i] + add) & 0xff
  }
}

/** Reads the `index`th sample of `bitDepth` bits from an unfiltered row. */
function sample(row: Buffer, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[index]
  if (bitDepth === 16) return row.readUInt16BE(index * 2)
  const bit = index * bitDepth
  return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1)
}

type RowTest = (row: Buffer, width: number) => boolean

function pixelTest(colorType: number, bitDepth: number, trns: Buffer | null): RowTest | null {
  const max = (1 << bitDepth) - 1
  if (colorType === 6 || colorType === 4) {
    const channels = colorType === 6 ? 4 : 2
    return (row, width) => {
      for (let x = 0; x < width; x++) if (sample(row, x * channels + channels - 1, bitDepth) < max) return true
      return false
    }
  }
  if (!trns) return null
  if (colorType === 3) {
    return (row, width) => {
      for (let x = 0; x < width; x++) {
        const index = sample(row, x, bitDepth)
        if (index < trns.length && trns[index] < 255) return true
      }
      return false
    }
  }
  if (colorType === 0 && trns.length >= 2) {
    const key = trns.readUInt16BE(0)
    return (row, width) => {
      for (let x = 0; x < width; x++) if (sample(row, x, bitDepth) === key) return true
      return false
    }
  }
  if (colorType === 2 && trns.length >= 6) {
    const key = [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
    return (row, width) => {
      for (let x = 0; x < width; x++) {
        if (
          sample(row, x * 3, bitDepth) === key[0] &&
          sample(row, x * 3 + 1, bitDepth) === key[1] &&
          sample(row, x * 3 + 2, bitDepth) === key[2]
        ) {
          return true
        }
      }
      return false
    }
  }
  return null
}

// ---------------------------------------------------------------- JPEG

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function readJpeg(data: Buffer): ImageMetadata {
  let offset = 2
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = data[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = data.readUInt16BE(offset + 2)
    if (SOF_MARKERS.has(marker) && offset + 9 < data.length) {
      return {
        format: 'jpeg',
        width: data.readUInt16BE(offset + 7),
        height: data.readUInt16BE(offset + 5),
        formatSupportsTransparency: false,
        hasAlphaChannel: false,
        hasTransparentPixels: false,
        animated: false,
        details: { progressive: marker === 0xc2, components: data[offset + 9] }
      }
    }
    offset += 2 + length
  }
  throw new Error('Could not find the size in this JPEG; the file may be damaged.')
}

// ---------------------------------------------------------------- GIF

function readGif(data: Buffer): ImageMetadata {
  const width = data.readUInt16LE(6)
  const height = data.readUInt16LE(8)
  const skipSubBlocks = (at: number): number => {
    let offset = at
    while (offset < data.length && data[offset] !== 0) offset += data[offset] + 1
    return offset + 1
  }
  let offset = 13
  if (data[10] & 0x80) offset += 3 * (1 << ((data[10] & 0x07) + 1))
  let frames = 0
  let transparentIndex = false
  while (offset < data.length) {
    const block = data[offset]
    if (block === 0x21) {
      if (data[offset + 1] === 0xf9 && data[offset + 3] & 0x01) transparentIndex = true
      offset = skipSubBlocks(offset + 2)
    } else if (block === 0x2c) {
      frames++
      const packed = data[offset + 9]
      offset += 10
      if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1))
      offset = skipSubBlocks(offset + 1)
    } else {
      break
    }
  }
  return {
    format: 'gif',
    width,
    height,
    formatSupportsTransparency: true,
    hasAlphaChannel: transparentIndex,
    hasTransparentPixels: transparentIndex ? null : false,
    animated: frames > 1,
    frames,
    details: { version: data.toString('latin1', 3, 6) }
  }
}

// ---------------------------------------------------------------- WebP

function readWebp(data: Buffer): ImageMetadata {
  let width: number | null = null
  let height: number | null = null
  let alpha = false
  let lossless = false
  let animatedFlag = false
  let frames = 0
  let offset = 12
  while (offset + 8 <= data.length) {
    const type = data.toString('latin1', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (type === 'VP8X' && body + 10 <= data.length) {
      const flags = data[body]
      alpha = alpha || (flags & 0x10) !== 0
      animatedFlag = (flags & 0x02) !== 0
      width = data.readUIntLE(body + 4, 3) + 1
      height = data.readUIntLE(body + 7, 3) + 1
    } else if (type === 'VP8 ' && body + 10 <= data.length && width === null) {
      width = data.readUInt16LE(body + 6) & 0x3fff
      height = data.readUInt16LE(body + 8) & 0x3fff
    } else if (type === 'VP8L' && body + 5 <= data.length) {
      lossless = true
      const bits = data.readUInt32LE(body + 1)
      if (width === null) {
        width = (bits & 0x3fff) + 1
        height = ((bits >> 14) & 0x3fff) + 1
      }
      alpha = alpha || ((bits >> 28) & 1) === 1
    } else if (type === 'ALPH') {
      alpha = true
    } else if (type === 'ANMF') {
      frames++
    }
    offset = body + size + (size & 1)
  }
  if (width === null || height === null) throw new Error('Could not find the size in this WebP; the file may be damaged.')
  return {
    format: 'webp',
    width,
    height,
    formatSupportsTransparency: true,
    hasAlphaChannel: alpha,
    hasTransparentPixels: alpha ? null : false,
    animated: animatedFlag && frames > 1,
    ...(frames > 0 ? { frames } : {}),
    details: { lossless }
  }
}

// ---------------------------------------------------------------- BMP

function readBmp(data: Buffer): ImageMetadata {
  const headerSize = data.readUInt32LE(14)
  const core = headerSize === 12
  const width = core ? data.readUInt16LE(18) : data.readInt32LE(18)
  const rawHeight = core ? data.readUInt16LE(20) : data.readInt32LE(22)
  const bitsPerPixel = core ? data.readUInt16LE(24) : data.readUInt16LE(28)
  const compression = core ? 0 : data.readUInt32LE(30)
  const alphaMask = headerSize >= 56 && data.length >= 70 ? data.readUInt32LE(66) : compression === 6 ? 1 : 0
  const hasAlphaChannel = bitsPerPixel === 32 && alphaMask !== 0

  let hasTransparentPixels: boolean | null = hasAlphaChannel ? null : false
  if (hasAlphaChannel && alphaMask === 0xff000000 && (compression === 0 || compression === 3)) {
    const pixels = data.readUInt32LE(10)
    const count = Math.abs(width * rawHeight)
    if (pixels + count * 4 <= data.length) {
      let seeThrough = false
      let allZero = true
      for (let i = 0; i < count; i++) {
        const a = data[pixels + i * 4 + 3]
        if (a !== 0) allZero = false
        if (a < 255) seeThrough = true
      }
      // An alpha byte that is zero everywhere means "unused", not "invisible".
      hasTransparentPixels = seeThrough && !allZero
    }
  }
  return {
    format: 'bmp',
    width,
    height: Math.abs(rawHeight),
    formatSupportsTransparency: true,
    hasAlphaChannel,
    hasTransparentPixels,
    animated: false,
    details: { bitsPerPixel, compression }
  }
}

// ---------------------------------------------------------------- SVG

/** A length attribute in pixels, or null for percentages and relative units. */
function svgLength(value: string | undefined): number | null {
  if (!value) return null
  const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value)
  if (match) return Number(match[1])
  const pt = /^\s*([\d.]+)\s*pt\s*$/i.exec(value)
  return pt ? Number(pt[1]) * (4 / 3) : null
}

function readSvg(text: string): ImageMetadata {
  const tag = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text)
  if (!tag) throw new Error('This SVG has no <svg> element.')
  const attributes: Record<string, string> = {}
  for (const match of tag[1].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  const viewBox = attributes.viewbox?.trim().split(/[\s,]+/).map(Number)
  const box = viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox : null
  let width = svgLength(attributes.width)
  let height = svgLength(attributes.height)
  if (box) {
    if (width === null && height === null) {
      width = box[2]
      height = box[3]
    } else if (width === null && height !== null && box[3] > 0) {
      width = (height * box[2]) / box[3]
    } else if (height === null && width !== null && box[2] > 0) {
      height = (width * box[3]) / box[2]
    }
  }
  const animated = /<(animate|animateTransform|animateMotion|set)\b/i.test(text) || /@keyframes\b/i.test(text)
  return {
    format: 'svg',
    width: width === null ? null : Math.round(width),
    height: height === null ? null : Math.round(height),
    formatSupportsTransparency: true,
    hasAlphaChannel: true,
    hasTransparentPixels: null,
    animated,
    details: { vector: true, ...(box ? { viewBox: box.join(' ') } : {}) }
  }
}
