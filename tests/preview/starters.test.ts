// @vitest-environment happy-dom
/// <reference path="../../src/core/tools/starters/raw.d.ts" />
import { beforeAll, describe, expect, it } from 'vitest'
import androidFrame from '../../src/core/tools/starters/android-frame.js?raw'
import browserWindow from '../../src/core/tools/starters/browser-window.js?raw'
import deckStage from '../../src/core/tools/starters/deck-stage.js?raw'
import docPage from '../../src/core/tools/starters/doc-page.js?raw'
import imageSlot from '../../src/core/tools/starters/image-slot.js?raw'
import iosFrame from '../../src/core/tools/starters/ios-frame.js?raw'
import macosWindow from '../../src/core/tools/starters/macos-window.js?raw'

const globalEval = eval

beforeAll(() => {
  for (const source of [deckStage, iosFrame, androidFrame, macosWindow, browserWindow, imageSlot, docPage]) globalEval(source)
})

const key = (target: EventTarget, name: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

describe('deck-stage', () => {
  it('shows one slide at a time and navigates with keys and goTo', () => {
    window.name = ''
    document.body.innerHTML =
      '<deck-stage width="1280" height="720"><section data-label="Title">1</section><section data-speaker-notes="n2">2</section><section>3</section></deck-stage>'
    const deck = document.querySelector('deck-stage') as any
    const slides = Array.from(deck.querySelectorAll('section')) as Element[]
    const active = (): number[] => slides.map((s, i) => (s.hasAttribute('data-deck-active') ? i : -1)).filter((i) => i >= 0)
    expect(active()).toEqual([0])
    expect(deck.shadowRoot.querySelector('.counter').textContent).toBe('1 / 3 · Title')
    expect(deck.style.getPropertyValue('--deck-w')).toBe('1280px')

    const changes: any[] = []
    deck.addEventListener('slidechange', (e: CustomEvent) => changes.push(e.detail))
    key(document.body, 'ArrowRight')
    expect(active()).toEqual([1])
    expect(changes[0]).toMatchObject({ index: 1, total: 3, notes: 'n2' })
    key(document.body, 'End')
    expect(deck.index).toBe(2)
    key(document.body, 'ArrowRight')
    expect(deck.index).toBe(2)
    deck.goTo(0)
    expect(active()).toEqual([0])
    expect(window.name).toContain('deck-stage:0')
    expect(document.getElementById('deck-stage-page')!.textContent).toContain('size: 1280px 720px')
  })

  it('keeps the position when slides are replaced and ignores keys typed into inputs', async () => {
    document.body.innerHTML = '<deck-stage><section>1</section><section>2</section><input></deck-stage>'
    const deck = document.querySelector('deck-stage') as any
    deck.goTo(1)
    key(deck.querySelector('input'), 'ArrowLeft')
    expect(deck.index).toBe(1)
    deck.querySelectorAll('section')[1].remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deck.index).toBe(0)
    expect(deck.querySelector('section')!.hasAttribute('data-deck-active')).toBe(true)
  })
})

describe('frames and shells', () => {
  it('define their elements and render their chrome in shadow DOM', async () => {
    document.body.innerHTML =
      '<ios-frame time="10:10"><p>screen</p></ios-frame><android-frame></android-frame><macos-window title="Notes"></macos-window>' +
      '<browser-window url="https://example.com/pricing"></browser-window><image-slot placeholder="Hero photo"></image-slot><doc-page size="a4"><section class="page">1</section></doc-page>'
    const shadow = (tag: string): ShadowRoot => (document.querySelector(tag) as HTMLElement).shadowRoot!
    expect(shadow('ios-frame').querySelector('.time')!.textContent).toBe('10:10')
    expect(shadow('android-frame').querySelector('.time')!.textContent).toBe('9:30')
    expect(shadow('macos-window').querySelector('.title')!.textContent).toBe('Notes')
    expect(shadow('browser-window').querySelector('.address')!.textContent).toBe('example.com/pricing')
    expect(shadow('image-slot').querySelector('.slot')!.textContent).toBe('Hero photo')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const doc = document.querySelector('doc-page') as HTMLElement
    expect(doc.hasAttribute('data-paged')).toBe(true)
    expect(doc.style.getPropertyValue('--page-w')).toBe('210mm')
  })
})
