/**
 * Images the user pastes or drops into a message, as Claude takes them. An API model gets each one
 * as an image part of the message. A command-line agent (Freebuff, OpenCode, Antigravity) can't be
 * handed an image that way, so each is saved in the project's .deskmates/attachments folder and the
 * message names its path for the agent to open.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'

export interface ImageAttachment {
  /** A data: URL, as the renderer reads a pasted or dropped image. */
  dataUrl: string
  name?: string
}

/** At most this many images per message, each at most this large (decoded). */
export const MAX_IMAGES = 6
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/

/** The media type and bytes of an image data URL; throws with a plain reason when it isn't one. */
export function decodeImage(image: ImageAttachment): { mediaType: string; base64: string; bytes: number } {
  const match = DATA_URL.exec(image.dataUrl.trim())
  if (!match) throw new Error(`${image.name ?? 'That file'} isn't a PNG, JPEG, GIF or WebP image.`)
  const base64 = match[2]!.replace(/\s+/g, '')
  const bytes = Math.floor((base64.length * 3) / 4)
  if (bytes > MAX_IMAGE_BYTES) throw new Error(`${image.name ?? 'An image'} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
  return { mediaType: match[1]!, base64, bytes }
}

// ---- Documents (PDF, Word, Excel, PowerPoint, text and code files) ----

/** At most this many characters of one document's text go to the model. */
export const MAX_DOCUMENT_CHARS = 150_000
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

const ANY_DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[^;,]+)*;base64,([A-Za-z0-9+/=\s]*)$/

/** Whether an attachment is a picture (an image part) rather than a document. */
export function isImageAttachment(attachment: ImageAttachment): boolean {
  return DATA_URL.test(attachment.dataUrl.trim())
}

/** The bytes of any attached file. */
export function decodeDocument(attachment: ImageAttachment): Buffer {
  const match = ANY_DATA_URL.exec(attachment.dataUrl.trim())
  if (!match) throw new Error(`${attachment.name ?? 'That file'} couldn't be read.`)
  const data = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64')
  if (data.length > MAX_DOCUMENT_BYTES) throw new Error(`${attachment.name ?? 'A file'} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`)
  return data
}

/** How a document travels in a message: one text part the timeline shows as a file chip. */
export function documentPart(name: string, text: string): string {
  const clean = name.replace(/["<>\n]/g, "'").slice(0, 200)
  const cut = text.length > MAX_DOCUMENT_CHARS
  return `<document name="${clean}">\n${cut ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[… the rest of the file (${text.length - MAX_DOCUMENT_CHARS} more characters) was left out]` : text}\n</document>`
}

const DOCUMENT_PART = /^<document name="([^"]*)">/

/** The file name of a document part, or null for ordinary text. */
export function documentName(text: string): string | null {
  return DOCUMENT_PART.exec(text)?.[1] ?? null
}

/** For a command-line agent: saves attached documents in the project and names their paths. */
export function textWithSavedDocuments(text: string, documents: ImageAttachment[], projectFolder: string): string {
  if (documents.length === 0) return text
  const dir = join(projectFolder, '.deskmates', 'attachments')
  mkdirSync(dir, { recursive: true })
  const paths = documents.map((doc) => {
    const name = (doc.name ?? 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file'
    const file = join(dir, `${randomUUID().slice(0, 6)}-${name}`)
    writeFileSync(file, decodeDocument(doc))
    return file
  })
  return `${text}\n\nAttached file${paths.length > 1 ? 's' : ''} (read ${paths.length > 1 ? 'them' : 'it'}):\n${paths.map((p) => `- ${p}`).join('\n')}`
}

/** The user message to store: text, image and document parts for an API model. */
export function userMessageWithImages(text: string, images: ImageAttachment[], documents: string[] = []): ModelMessage {
  if (documents.length > 0) {
    const parts = images.map((image) => {
      const { mediaType, base64 } = decodeImage(image)
      return { type: 'image' as const, image: base64, mediaType }
    })
    return { role: 'user', content: [{ type: 'text', text }, ...documents.map((doc) => ({ type: 'text' as const, text: doc })), ...parts] }
  }
  if (images.length === 0) return { role: 'user', content: text }
  if (images.length > MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images to one message.`)
  const parts = images.map((image) => {
    const { mediaType, base64 } = decodeImage(image)
    return { type: 'image' as const, image: base64, mediaType }
  })
  return { role: 'user', content: [{ type: 'text', text }, ...parts] }
}

/** For a command-line agent: saves the images in the project and adds their paths to the text. */
export function textWithSavedImages(text: string, images: ImageAttachment[], projectFolder: string): string {
  if (images.length === 0) return text
  if (images.length > MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images to one message.`)
  const dir = join(projectFolder, '.deskmates', 'attachments')
  mkdirSync(dir, { recursive: true })
  const paths = images.map((image) => {
    const { mediaType, base64 } = decodeImage(image)
    const extension = mediaType.split('/')[1] === 'jpeg' ? 'jpg' : mediaType.split('/')[1]
    const file = join(dir, `image-${randomUUID().slice(0, 8)}.${extension}`)
    writeFileSync(file, Buffer.from(base64, 'base64'))
    return file
  })
  return `${text}\n\nAttached image${paths.length > 1 ? 's' : ''} (open ${paths.length > 1 ? 'them' : 'it'} to see what I mean):\n${paths.map((p) => `- ${p}`).join('\n')}`
}
