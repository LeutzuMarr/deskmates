/**
 * Animated GIFs of a Chrome session (gif_creator): Chrome's PNG screenshots decoded with Node's zlib,
 * the overlays drawn into the pixels (click rings, drag lines, action labels, a progress bar), and
 * the frames encoded as a GIF89a with one fixed 252-colour palette and LZW. No libraries needed.
 */
import { inflateSync } from 'node:zlib'

export interface Rgba {
  width: number
  height: number
  /** width × height × 4 bytes. */
  data: Uint8Array
}

/** What happened just before a frame was taken, for the overlays. */
export interface FrameAction {
  label: string
  /** A click or hover, in the frame's own pixels. */
  point?: [number, number]
  /** A drag, in the frame's own pixels. */
  from?: [number, number]
  to?: [number, number]
}

export interface GifOptions {
  showClickIndicators?: boolean
  showDragPaths?: boolean
  showActionLabels?: boolean
  showProgressBar?: boolean
  /** Hundredths of a second each frame stays up. */
  delayCs?: number
}

// ---- PNG ----

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome's screenshots are). */
export function decodePng(png: Uint8Array): Rgba {
  const bytes = Buffer.from(png)
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG.')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9]!
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error('Only 8-bit RGB/RGBA PNGs without interlacing can be read.')
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const line = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const start = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const value = raw[start + x]!
      const left = x >= channels ? line[x - channels]! : 0
      const up = prev[x]!
      const upLeft = x >= channels ? prev[x - channels]! : 0
      let result: number
      switch (filter) {
        case 1:
          result = value + left
          break
        case 2:
          result = value + up
          break
        case 3:
          result = value + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          result = value
      }
      line[x] = result & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o] = line[x * channels]!
      out[o + 1] = line[x * channels + 1]!
      out[o + 2] = line[x * channels + 2]!
      out[o + 3] = channels === 4 ? line[x * channels + 3]! : 255
    }
    prev.set(line)
  }
  return { width, height, data: out }
}

/** Nearest-neighbour resize, so every frame of a GIF has the first frame's size. */
export function resize(image: Rgba, width: number, height: number): Rgba {
  if (image.width === width && image.height === height) return image
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width))
      out.set(image.data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * width + x) * 4)
    }
  }
  return { width, height, data: out }
}

// ---- Drawing ----

type Color = [number, number, number]
const ORANGE: Color = [242, 140, 40]
const RED: Color = [214, 52, 52]
const BLACK: Color = [20, 20, 20]
const WHITE: Color = [250, 250, 250]

function plot(image: Rgba, x: number, y: number, color: Color): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const o = (Math.round(y) * image.width + Math.round(x)) * 4
  image.data[o] = color[0]
  image.data[o + 1] = color[1]
  image.data[o + 2] = color[2]
}

function rect(image: Rgba, x0: number, y0: number, w: number, h: number, color: Color): void {
  for (let y = Math.max(0, y0); y < Math.min(image.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(image.width, x0 + w); x++) plot(image, x, y, color)
}

function ring(image: Rgba, cx: number, cy: number, radius: number, thickness: number, color: Color): void {
  for (let y = -radius - thickness; y <= radius + thickness; y++) {
    for (let x = -radius - thickness; x <= radius + thickness; x++) {
      const d = Math.sqrt(x * x + y * y)
      if (d >= radius - thickness / 2 && d <= radius + thickness / 2) plot(image, cx + x, cy + y, color)
    }
  }
}

function line(image: Rgba, from: [number, number], to: [number, number], color: Color, thickness = 2): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1])))
  for (let i = 0; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps
    const y = from[1] + ((to[1] - from[1]) * i) / steps
    rect(image, Math.round(x - thickness / 2), Math.round(y - thickness / 2), thickness, thickness, color)
  }
}

/** A 3×5 pixel font: each glyph is five rows of three bits, top row first. */
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', ' ': '000000000000000', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000',
  '-': '000000111000000', '/': '001001010100100', '(': '010100100100010', ')': '010001001001010', "'": '010010000000000',
  '"': '101101000000000', '?': '110001010000010', '!': '010010010000010', '=': '000111000111000', '+': '000010111010000',
  _: '000000000000111', '@': '111101111100111', '#': '101111101111101', '%': '101001010100101', '&': '010101010101011',
  '<': '001010100010001', '>': '100010001010100', '[': '110100100100110', ']': '011001001001011', '*': '101010101000000'
}

function text(image: Rgba, value: string, x: number, y: number, scale: number, color: Color): number {
  let cursor = x
  for (const ch of value.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT['?']!
    for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (glyph[row * 3 + col] === '1') rect(image, cursor + col * scale, y + row * scale, scale, scale, color)
    cursor += 4 * scale
  }
  return cursor - x
}

/** Draws the overlays for one frame, in place. */
export function drawOverlays(image: Rgba, action: FrameAction | undefined, index: number, count: number, options: GifOptions): void {
  if (action?.point && options.showClickIndicators !== false) {
    ring(image, action.point[0], action.point[1], 14, 3, ORANGE)
    ring(image, action.point[0], action.point[1], 4, 3, ORANGE)
  }
  if (action?.from && action.to && options.showDragPaths !== false) {
    line(image, action.from, action.to, RED, 3)
    ring(image, action.to[0], action.to[1], 6, 3, RED)
  }
  if (action?.label && options.showActionLabels !== false) {
    const label = action.label.slice(0, 60)
    const scale = image.width >= 900 ? 3 : 2
    const width = label.length * 4 * scale + 12
    rect(image, 8, 8, Math.min(width, image.width - 16), 5 * scale + 12, BLACK)
    text(image, label, 14, 14, scale, WHITE)
  }
  if (options.showProgressBar !== false && count > 1) {
    rect(image, 0, image.height - 5, image.width, 5, [60, 60, 60])
    rect(image, 0, image.height - 5, Math.round((image.width * (index + 1)) / count), 5, ORANGE)
  }
}

// ---- GIF ----

/** The fixed palette: 6 reds × 7 greens × 6 blues (252 colours), padded to 256. */
function palette(): Uint8Array {
  const out = new Uint8Array(256 * 3)
  let i = 0
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) {
    out[i++] = Math.round((r * 255) / 5)
    out[i++] = Math.round((g * 255) / 6)
    out[i++] = Math.round((b * 255) / 5)
  }
  return out
}

function indexed(image: Rgba): Uint8Array {
  const out = new Uint8Array(image.width * image.height)
  for (let p = 0, o = 0; p < out.length; p++, o += 4) {
    const r = Math.round((image.data[o]! * 5) / 255)
    const g = Math.round((image.data[o + 1]! * 6) / 255)
    const b = Math.round((image.data[o + 2]! * 5) / 255)
    out[p] = r * 42 + g * 6 + b
  }
  return out
}

/** LZW-compresses palette indices the way GIF wants, as 255-byte sub-blocks. */
export function lzwEncode(pixels: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize
  const end = clear + 1
  const bytes: number[] = []
  let codeSize = minCodeSize + 1
  let next = end + 1
  let dict = new Map<number, number>()
  let accumulator = 0
  let bits = 0
  const write = (code: number): void => {
    accumulator |= code << bits
    bits += codeSize
    while (bits >= 8) {
      bytes.push(accumulator & 0xff)
      accumulator >>>= 8
      bits -= 8
    }
  }
  write(clear)
  if (pixels.length === 0) {
    write(end)
  } else {
    let prefix = pixels[0]!
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i]!
      const key = prefix * 256 + k
      const found = dict.get(key)
      if (found !== undefined) {
        prefix = found
        continue
      }
      write(prefix)
      if (next >= 1 << codeSize && codeSize < 12) codeSize++
      if (next < 4096) dict.set(key, next++)
      else {
        write(clear)
        dict = new Map()
        codeSize = minCodeSize + 1
        next = end + 1
      }
      prefix = k
    }
    write(prefix)
    if (next >= 1 << codeSize && codeSize < 12) codeSize++
    write(end)
  }
  if (bits > 0) bytes.push(accumulator & 0xff)
  const blocks: number[] = []
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255)
    blocks.push(chunk.length, ...chunk)
  }
  blocks.push(0)
  return Uint8Array.from(blocks)
}

/** An animated, looping GIF of the frames (all resized to the first frame's size). */
export function encodeGif(frames: Rgba[], options: GifOptions = {}): Uint8Array {
  if (frames.length === 0) throw new Error('There are no frames to make a GIF from.')
  const { width, height } = frames[0]!
  const parts: number[] = []
  const push = (...values: number[]): void => void parts.push(...values)
  const word = (value: number): void => push(value & 0xff, (value >> 8) & 0xff)
  push(...Buffer.from('GIF89a', 'latin1'))
  word(width)
  word(height)
  push(0xf7, 0, 0) // global colour table of 256 entries
  push(...palette())
  // Loop forever.
  push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00)
  const delay = options.delayCs ?? 80
  const chunks: Uint8Array[] = [Uint8Array.from(parts)]
  for (const frame of frames) {
    const image = resize(frame, width, height)
    const head: number[] = []
    head.push(0x21, 0xf9, 0x04, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00)
    head.push(0x2c, 0, 0, 0, 0, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff, 0x00, 0x08)
    chunks.push(Uint8Array.from(head), lzwEncode(indexed(image)))
  }
  chunks.push(Uint8Array.from([0x3b]))
  return Buffer.concat(chunks)
}
