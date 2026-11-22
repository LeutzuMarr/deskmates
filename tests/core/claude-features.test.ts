import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeImage, textWithSavedImages, userMessageWithImages } from '../../src/core/engine/attachments'
import { buildTimeline } from '../../src/core/engine/timeline'
import { chatMarkdown } from '../../src/renderer/src/lib/chat-markdown'
import { speakableText } from '../../src/renderer/src/lib/speakable'
import { openDatabase } from '../../src/core/store/db'
import { createRepos } from '../../src/core/store/repos'

// A 1×1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('images in messages', () => {
  it('sends pictures to an API model as image parts and shows them in the chat', () => {
    const message = userMessageWithImages('What is this?', [{ dataUrl: PNG }])
    expect(Array.isArray(message.content)).toBe(true)
    const parts = message.content as Array<{ type: string; mediaType?: string }>
    expect(parts.map((p) => p.type)).toEqual(['text', 'image'])
    expect(parts[1]!.mediaType).toBe('image/png')
    const [item] = buildTimeline([{ message, at: 1 }])
    expect(item).toMatchObject({ kind: 'user', text: 'What is this?', images: [PNG] })
  })

  it('saves pictures for a command-line agent and names their paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-attach-'))
    try {
      const text = textWithSavedImages('Fix this', [{ dataUrl: PNG }], dir)
      const path = /- (.+\.png)/.exec(text)?.[1]
      expect(path && existsSync(path)).toBe(true)
      expect(readFileSync(path!).subarray(1, 4).toString()).toBe('PNG')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses what is not a picture', () => {
    expect(() => decodeImage({ dataUrl: 'data:text/plain;base64,aGk=', name: 'notes.txt' })).toThrow(/notes.txt isn't a PNG/)
    expect(() => userMessageWithImages('x', Array.from({ length: 7 }, () => ({ dataUrl: PNG })))).toThrow(/at most 6/)
  })
})

describe('chat export and read aloud', () => {
  it('writes the chat as Markdown with the steps as a list', () => {
    const md = chatMarkdown('Fix header', [
      { kind: 'user', id: 'u', at: 1, text: 'Fix the header' },
      { kind: 'tool', id: 't', at: 2, toolName: 'read_file', input: { path: 'a.ts' }, state: 'done' },
      { kind: 'assistant', id: 'a', at: 3, text: 'Done.' }
    ])
    expect(md).toBe('# Fix header\n\n## You\n\nFix the header\n\n- Read a.ts\n\nDone.\n')
  })

  it('reads replies without Markdown symbols', () => {
    expect(speakableText('### Done\n- **Fixed** `a.ts`, see [docs](https://x)\n```js\nx\n```')).toBe('Done Fixed a.ts, see docs (code block)')
  })
})

describe('pinned chats', () => {
  it('lists pinned chats first, and pinning keeps the chat’s time', () => {
    const db = openDatabase(':memory:')
    const repos = createRepos(db)
    const project = repos.projects.create('P', 'C:\\p')
    const older = repos.tasks.create(project.id, 'older')
    const newer = repos.tasks.create(project.id, 'newer')
    repos.tasks.update(newer.id, { title: 'newer' })
    const before = repos.tasks.require(older.id).updatedAt
    expect(repos.tasks.setPinned(older.id, true).pinned).toBe(true)
    expect(repos.tasks.require(older.id).updatedAt).toBe(before)
    expect(repos.tasks.list(project.id).map((t) => t.title)).toEqual(['older', 'newer'])
  })
})
