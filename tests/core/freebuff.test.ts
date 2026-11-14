import { afterEach, describe, expect, it } from 'vitest'
import {
  countEchoes,
  currentActivity,
  workItems,
  extractReply,
  hasRetry,
  hasSurvey,
  highlightedModel,
  inputDraft,
  isBusy,
  isIdle,
  latestReply,
  readStatus,
  withoutCursor
} from '../../src/core/terminals/freebuff-host'
import { FREEBUFF_CURRENT_MODEL, FREEBUFF_MODELS, freebuffModelIds, freebuffModelLabel, parsePickerCards, setFreebuffModels } from '../../src/shared/freebuff'

// Real Freebuff 0.2.35 screens, captured from a hidden console.
const DONE = `   [06:29 PM]
   Now reply with exactly: SECOND OK ⎘
  SECOND OK
                                                                                                ⎘ • 2s • △▽
 41m left · 22.8K (5%)                                                                         ✕ End session
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                                                                            │
│  ▍Enter a coding task or / for commands                                                                    │
│                                                                                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
 Solar Pro 4 · ~\\AppData\\Local\\Temp\\hidden-test · /model to change · Chat: Reply with exactly: HIDDEN OK`

const WORKING = `   [06:11 PM]
   Look at the screen, then point at the Start
   button. ⎘
  • Read AGENTS.md
  $ dir
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ quick question 1/11  □□□□□□□□□□□                                                                                   │
│ 1 Me   2 My employer   3 Both   4 Nobody, I stick to free tools   0 Doesn't apply                                  │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
 thinking...                                                                                                54s  ■ Esc
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ▍Add to the current task (/ for commands)                                                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯`

const BANNER = ` ┌──────────────────────────────────────────────────────────────────┐
 │ May use data for AI training                                     │
 │ Session active                                                   │
 │ 12/12 hours remaining                                            │
 └──────────────────────────────────────────────────────────────────┘
 34m left · 35K (7%)                                                                           ✕ End session`

const PICKER = ` ↑↓ choose model · Tab reasoning · Enter select · Esc cancel
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │   MiMo v2.6 Flash Slow · Slow · cheapest · Images                            │
 │                                      1x                                      │
 └──────────────────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ › Solar Pro 4 · Upstage flagship · Promotional                               │
 │                         May use data for AI training                         │
 └──────────────────────────────────────────────────────────────────────────────┘`

describe('Freebuff screen reading', () => {
  it('reads a finished reply between the prompt echo and its footer', () => {
    expect(extractReply(DONE, 'Now reply with exactly: SECOND OK')).toEqual({ text: 'SECOND OK', done: true })
    expect(isIdle(DONE)).toBe(true)
    expect(isBusy(DONE)).toBe(false)
    expect(inputDraft(DONE)).toBe('')
  })

  it('follows a wrapped prompt echo and reports work in progress', () => {
    const prompt = 'Look at the screen, then point at the Start button.'
    expect(extractReply(WORKING, prompt)).toEqual({ text: '• Read AGENTS.md\n$ dir', done: false })
    expect(isBusy(WORKING)).toBe(true)
    expect(isIdle(WORKING)).toBe(false)
    expect(hasSurvey(WORKING)).toBe(true)
    expect(currentActivity(WORKING, prompt)).toBe('$ dir')
    expect(workItems(WORKING, prompt)).toEqual(['• Read AGENTS.md', '$ dir'])
  })

  it('ignores the chat title in the status bar, and earlier copies of the same request', () => {
    const screen = `   [07:24 PM]
   What is two plus two? ⎘
  Two plus two is four.
                                                                                                ⎘ • 2s • △▽
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ▍Enter a coding task or / for commands                                                                    │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
 Solar Pro 4 · ~\\AppData\\Roaming\\project · /model to change · Chat: What is two plus two?`
    expect(extractReply(screen, 'What is two plus two?')).toEqual({ text: 'Two plus two is four.', done: true })
    expect(countEchoes(screen, 'What is two plus two?')).toBe(1)
    expect(extractReply(screen, 'What is two plus two?', 1)).toBeNull()
  })

  it('treats a cursor blink as no change and spots the server timeout card', () => {
    expect(withoutCursor('│  ▍Enter a coding task │')).toBe(withoutCursor('│   Enter a coding task │'))
    expect(hasRetry('│ Enter: retry  Esc: back to draft │')).toBe(true)
  })

  it('finds text left in the input box, and reads a help-mode placeholder as empty', () => {
    const leftover = `╭──────╮
│  hello there                    │
╰──────╯`
    expect(inputDraft(leftover)).toBe('hello there')
    const help = `╭──────╮
│  enter a coding task or / for commands   │
╰──────╯`
    expect(inputDraft(help)).toBe('')
  })

  it('reads the session status: model, minutes left, hours today, context', () => {
    expect(readStatus(`${BANNER}\n${DONE}`)).toEqual({
      model: 'Solar Pro 4',
      sessionMinutesLeft: 34,
      hoursLeftToday: 12,
      hoursPerDay: 12,
      context: '35K (7%)'
    })
    // Freebuff's keyboard hint on the same line isn't the model.
    expect(readStatus(' ↻ ← for history · ? for help · Solar Pro 4 · ~\\Desktop\\outreach · /model to change').model).toBe('Solar Pro 4')
    expect(readStatus(' ↻ ← for history · ? for help · /model to change').model).toBeNull()
    expect(readStatus('1h 5m left · 2K (1%)').sessionMinutesLeft).toBe(65)
    expect(readStatus(' 1h left · 2K (1%)').sessionMinutesLeft).toBe(60)
    expect(readStatus('nothing here')).toEqual({ model: null, sessionMinutesLeft: null, hoursLeftToday: null, hoursPerDay: null, context: null })
  })

  it("reads the /model picker's highlighted row", () => {
    expect(highlightedModel(PICKER)).toBe('Solar Pro 4')
    expect(highlightedModel(' │ › Muse Spark 1.3 • high · Falls back when busy │')).toBe('Muse Spark 1.3')
    expect(highlightedModel(DONE)).toBeNull()
  })
})

// A long turn: the request has scrolled off the top of Freebuff's 70-line window.
const SCROLLED = `  • browser_read https://scuola.example/compiti
  • duo_todo_add Verifica di scienze
  Ho letto i compiti.
  Verifica di scienze lunedì 16.
                                                                                                ⎘ • 4m 12s • △▽
 41m left · 22.8K (5%)                                                                         ✕ End session
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ▍Enter a coding task or / for commands                                                                    │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯`

describe('Freebuff reply after the request scrolled away', () => {
  it('reads the reply from above its footer when the echo is gone', () => {
    expect(extractReply(SCROLLED, 'do the daily brief')).toBeNull()
    expect(isIdle(SCROLLED)).toBe(true)
    expect(latestReply(SCROLLED)).toBe(
      '• browser_read https://scuola.example/compiti\n• duo_todo_add Verifica di scienze\nHo letto i compiti.\nVerifica di scienze lunedì 16.'
    )
  })

  it('stops at the request echo when it is still on screen', () => {
    expect(latestReply(DONE)).toBe('SECOND OK')
    expect(latestReply(WORKING)).toBeNull()
  })

  it('still reports the latest line of work once the echo is gone', () => {
    const busy = `  • browser_open https://mail.zoho.eu
  • browser_read
 thinking...                                                                                                54s  ■ Esc
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ▍Add to the current task (/ for commands)                                                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯`
    expect(currentActivity(busy, 'do the daily brief')).toBe('• browser_read')
  })
})

describe('Freebuff model list', () => {
  afterEach(() => setFreebuffModels(FREEBUFF_MODELS))

  it("offers Freebuff's current model first, then the models cheapest first", () => {
    const ids = freebuffModelIds()
    expect(ids[0]).toBe(FREEBUFF_CURRENT_MODEL)
    expect(ids).toContain('Solar Pro 4')
    // Free models first, then 1x, 2x…, paid plan last.
    expect(ids.indexOf('Solar Pro 4')).toBeLessThan(ids.indexOf('MiMo v2.6 Flash Slow'))
    expect(ids.indexOf('MiMo v2.6 Flash Slow')).toBeLessThan(ids.indexOf('DeepSeek V4.1 Flash Fast'))
    expect(ids.indexOf('GPT-6.1 Terra')).toBeLessThan(ids.indexOf('GPT-6.1 Sol'))
    expect(ids[ids.length - 1]).toBe('GPT-6.1 Sol')
  })

  it('labels each model with its cost: Freebucks, free, or paid plan', () => {
    expect(freebuffModelLabel('MiMo v2.6 Flash Slow')).toBe('MiMo v2.6 Flash Slow · 1x Freebucks · slow, cheapest')
    expect(freebuffModelLabel('Solar Pro 4')).toBe('Solar Pro 4 · free (unlimited) · promotional')
    expect(freebuffModelLabel('GPT-6.1 Sol')).toBe('GPT-6.1 Sol · paid plan · 1 session a day')
    expect(freebuffModelLabel(FREEBUFF_CURRENT_MODEL)).toBe("Freebuff's current model")
    expect(freebuffModelLabel('Some New Model')).toBe('Some New Model')
  })

  it("reads the model cards and their cost off Freebuff's picker", () => {
    expect(parsePickerCards(PICKER)).toEqual([
      { name: 'MiMo v2.6 Flash Slow', cost: '1x', note: 'Slow · cheapest · Images' },
      { name: 'Solar Pro 4', cost: null, note: 'Upstage flagship · Promotional' }
    ])
  })

  it('replaces the list with a fresh read, dropping models Freebuff no longer offers', () => {
    setFreebuffModels([
      { name: 'New Paid', cost: 'Paid plan' },
      { name: 'New Pricey', cost: '5x' },
      { name: 'New Free', cost: null }
    ])
    expect(freebuffModelIds()).toEqual([FREEBUFF_CURRENT_MODEL, 'New Free', 'New Pricey', 'New Paid'])
    expect(freebuffModelLabel('New Pricey')).toBe('New Pricey · 5x Freebucks')
    setFreebuffModels([])
    expect(freebuffModelIds()).toContain('New Free') // an empty read never wipes the list
  })
})
