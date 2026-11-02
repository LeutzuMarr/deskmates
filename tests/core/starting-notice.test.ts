import { describe, expect, it } from 'vitest'
import { awaitingFirstOutput, startingNotice } from '../../src/renderer/src/lib/format'
import type { TimelineItem } from '../../src/shared/protocol'

const user = (id: string): TimelineItem => ({ kind: 'user', id, at: 0, text: 'hi' })
const assistant = (id: string): TimelineItem => ({ kind: 'assistant', id, at: 1, text: 'ok' })
const tool = (id: string): TimelineItem => ({ kind: 'tool', id, at: 1, toolName: 'read', input: {}, state: 'running' })

describe('awaitingFirstOutput', () => {
  it('is true while a run is up and only the prompt is on the transcript', () => {
    // The user bubble is persisted and broadcast before the run starts, so this exact shape is the
    // whole of a CLI provider's cold start.
    expect(awaitingFirstOutput([user('u1')], true)).toBe(true)
  })

  it('is true for an empty transcript, such as a scheduled run with no prompt', () => {
    expect(awaitingFirstOutput([], true)).toBe(true)
  })

  it('is false once any part of the reply lands, whether text or a tool call', () => {
    expect(awaitingFirstOutput([user('u1'), tool('t1')], true)).toBe(false)
    expect(awaitingFirstOutput([user('u1'), assistant('a1')], true)).toBe(false)
  })

  it('is false when a later turn has started, since the newest prompt is the one being answered', () => {
    expect(awaitingFirstOutput([user('u1'), assistant('a1'), user('u2')], true)).toBe(true)
    expect(awaitingFirstOutput([user('u1'), assistant('a1'), user('u2'), tool('t2')], true)).toBe(false)
  })

  it('is false when nothing is running, whatever is on the transcript', () => {
    expect(awaitingFirstOutput([], false)).toBe(false)
    expect(awaitingFirstOutput([user('u1')], false)).toBe(false)
  })
})

describe('startingNotice', () => {
  it('names the CLI, since its silence is long enough to look like a hang', () => {
    expect(startingNotice({ provider: 'opencode', modelId: 'opencode/big-pickle' })).toEqual({
      label: 'Starting OpenCode…',
      hint: 'It boots a whole agent process before it replies — this can take a minute.'
    })
  })

  it('covers the other CLI provider', () => {
    expect(startingNotice({ provider: 'agy', modelId: 'x' })?.label).toBe('Starting Agy…')
  })

  it('stays out of the way for providers that stream a token straight away', () => {
    expect(startingNotice({ provider: 'google', modelId: 'gemini-2.5-pro' })).toBeNull()
    expect(startingNotice({ provider: 'ollama', modelId: 'llama' })).toBeNull()
  })

  it('drops the OpenCode notice once a folder already has a server', () => {
    // The second prompt in a folder answers in about a second and a half, so "this can take a
    // minute" would be both false and a standing reminder that everything restarts each turn.
    expect(startingNotice({ provider: 'opencode', modelId: 'opencode/big-pickle' }, true)).toBeNull()
  })

  it('keeps the OpenCode notice on a cold start, and for agy even when the folder is warm', () => {
    // Cold is the one case the warning is for. agy has no reusable server, so `warm` is meaningless
    // for it and must not suppress the notice.
    expect(startingNotice({ provider: 'opencode', modelId: 'opencode/big-pickle' }, false)).not.toBeNull()
    expect(startingNotice({ provider: 'agy', modelId: 'x' }, true)).not.toBeNull()
  })

  it('has nothing to say when no model is chosen', () => {
    expect(startingNotice(null)).toBeNull()
    expect(startingNotice(undefined)).toBeNull()
    expect(startingNotice(null, true)).toBeNull()
  })
})
