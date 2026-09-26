// Generates resources/icon.png: Deskmates' mascot, Mate — a cup of yerba mate with a face.
// No dependencies: rasterizes flat-shaded vector shapes by hand and encodes PNG with node:zlib
// plus a hand-rolled CRC32 (the checksum every PNG chunk needs).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SIZE = 512
const SUPERSAMPLE = 4

const COLORS = {
  square: [0xd9, 0x77, 0x57], // clay orange
  cup: [0xf7, 0xf6, 0xf2], // warm white
  band: [0xf2, 0xd5, 0xc7], // dusty pink
  straw: [0x3a, 0x39, 0x36], // charcoal
  face: [0x29, 0x26, 0x1f] // near-black (eyes + smile)
}

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi)
}

// A rounded rectangle is exactly the set of points within `radius` of the rectangle
// shrunk by `radius` on each side — clamping to that inner rect and checking the
// distance handles the flat edges and the four corner arcs in one formula.
function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  const cx = clamp(x, x0 + radius, x1 - radius)
  const cy = clamp(y, y0 + radius, y1 - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function insideEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return dx * dx + dy * dy <= 1
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1)
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function insideCupBody(x, y) {
  return insideRoundedRect(x, y, 140, 176, 372, 428, 64)
}

// Painter's order, topmost first: whichever shape hit-tests first wins the sample.
function colorAt(x, y) {
  const smileDist = Math.hypot(x - 256, y - 300)
  if (y >= 300 && smileDist >= 34 - 4.5 && smileDist <= 34 + 4.5) return COLORS.face

  if (insideEllipse(x, y, 216, 268, 16, 21)) return COLORS.face
  if (insideEllipse(x, y, 296, 268, 16, 21)) return COLORS.face

  if (distanceToSegment(x, y, 300, 196, 384, 64) <= 11) return COLORS.straw

  if (y >= 340 && y <= 366 && insideCupBody(x, y)) return COLORS.band

  if (insideCupBody(x, y)) return COLORS.cup

  if (insideRoundedRect(x, y, 0, 0, SIZE, SIZE, 112)) return COLORS.square

  return null
}

function rasterize() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let hits = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const y = py + (sy + 0.5) / SUPERSAMPLE
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) / SUPERSAMPLE
          const color = colorAt(x, y)
          if (color) {
            sumR += color[0]
            sumG += color[1]
            sumB += color[2]
            hits++
          }
        }
      }

      const i = (py * SIZE + px) * 4
      if (hits > 0) {
        pixels[i] = Math.round(sumR / hits)
        pixels[i + 1] = Math.round(sumG / hits)
        pixels[i + 2] = Math.round(sumB / hits)
        pixels[i + 3] = Math.round((hits / samples) * 255)
      }
      // else: leave fully transparent (Buffer.alloc already zero-fills)
    }
  }

  return pixels
}

// Standard IEEE 802.3 CRC-32 (polynomial 0xEDB88320), as required by the PNG spec.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // width
  ihdr.writeUInt32BE(size, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let row = 0; row < size; row++) {
    const rowStart = row * (stride + 1)
    raw[rowStart] = 0 // filter type: None
    pixels.copy(raw, rowStart + 1, row * stride, row * stride + stride)
  }
  const idat = deflateSync(raw)

  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

const pixels = rasterize()
const png = encodePng(pixels, SIZE)

const outDir = join(import.meta.dirname, '..', 'resources')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'icon.png')
writeFileSync(outPath, png)

console.log(`Wrote ${outPath} (${png.length} bytes)`)
