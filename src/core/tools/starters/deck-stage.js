/**
 * <deck-stage width="1920" height="1080"> — a slide deck shell.
 *
 * Every child <section> is one slide, laid out at width × height and scaled to fit the window.
 * Arrow keys, Page Up/Down, Space, Home/End, the on-screen buttons and clicks on the slide move
 * between slides; printing gives one page per slide. A section's data-label shows next to the
 * counter and its data-speaker-notes travel with the `slidechange` event.
 *
 *   document.querySelector('deck-stage').goTo(2)  // 0-indexed
 */
;(() => {
  if (customElements.get('deck-stage')) return

  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, video, audio, [contenteditable], [tabindex], [data-deck-no-advance]'

  const STYLE = `
    :host {
      position: fixed;
      inset: 0;
      display: block;
      overflow: hidden;
      background: #1b1b1a;
      --deck-w: 1920px;
      --deck-h: 1080px;
      --deck-scale: 1;
    }
    .viewport { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .canvas {
      position: relative;
      flex: none;
      width: var(--deck-w);
      height: var(--deck-h);
      transform: scale(var(--deck-scale));
      transform-origin: center center;
      background: #fff;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }
    ::slotted(*) {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      box-sizing: border-box;
      overflow: hidden;
    }
    ::slotted(:not(section)) { display: none !important; }
    @media screen {
      ::slotted(section:not([data-deck-active])) { display: none !important; }
    }
    .hud {
      position: absolute;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: rgba(20, 20, 19, 0.72);
      color: #faf9f5;
      font: 500 13px/1 system-ui, sans-serif;
      opacity: 0;
      transition: opacity 200ms ease;
      user-select: none;
    }
    :host(:hover) .hud, .hud:focus-within, :host([data-deck-hud]) .hud { opacity: 1; }
    .hud button {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 16px;
      cursor: pointer;
    }
    .hud button:hover { background: rgba(255, 255, 255, 0.14); }
    .hud button:disabled { opacity: 0.35; cursor: default; background: transparent; }
    .counter { padding: 0 8px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    @media print {
      :host { position: static !important; background: none !important; overflow: visible !important; }
      .viewport { position: static !important; display: block !important; }
      .canvas { transform: none !important; width: auto !important; height: auto !important; box-shadow: none !important; overflow: visible !important; }
      .hud { display: none !important; }
      ::slotted(section) {
        display: block !important;
        position: relative !important;
        inset: auto !important;
        width: var(--deck-w) !important;
        height: var(--deck-h) !important;
        break-after: page;
        page-break-after: always;
      }
      ::slotted(section:last-of-type) { break-after: auto; page-break-after: auto; }
    }
  `

  /** @param {string | null} value @param {number} fallback */
  const size = (value, fallback) => {
    const n = parseFloat(value || '')
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  class DeckStage extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height']
    }

    constructor() {
      super()
      this._index = 0
      this._hudTimer = 0
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = `<style>${STYLE}</style>
        <div class="viewport" part="viewport"><div class="canvas" part="canvas"><slot></slot></div></div>
        <div class="hud" part="controls">
          <button type="button" class="prev" aria-label="Previous slide">&#8249;</button>
          <span class="counter" aria-live="polite"></span>
          <button type="button" class="next" aria-label="Next slide">&#8250;</button>
        </div>`
      this._counter = root.querySelector('.counter')
      this._prevButton = root.querySelector('.prev')
      this._nextButton = root.querySelector('.next')
      this._prevButton.addEventListener('click', (event) => {
        event.stopPropagation()
        this.prev()
      })
      this._nextButton.addEventListener('click', (event) => {
        event.stopPropagation()
        this.next()
      })
      root.querySelector('slot').addEventListener('slotchange', () => this._sync())
      this._onKey = this._onKey.bind(this)
      this._onResize = () => this._fit()
      this._onMove = () => this._showHud()
      this.addEventListener('click', (event) => this._onClick(event))
    }

    connectedCallback() {
      this._applySize()
      this._index = this._restoredIndex()
      document.addEventListener('keydown', this._onKey)
      window.addEventListener('resize', this._onResize)
      this.addEventListener('pointermove', this._onMove)
      if (typeof ResizeObserver === 'function') {
        this._resizeObserver = new ResizeObserver(this._onResize)
        this._resizeObserver.observe(this)
      }
      this._mutationObserver = new MutationObserver(() => this._sync())
      this._mutationObserver.observe(this, { childList: true })
      this._sync()
      this._fit()
    }

    disconnectedCallback() {
      document.removeEventListener('keydown', this._onKey)
      window.removeEventListener('resize', this._onResize)
      this.removeEventListener('pointermove', this._onMove)
      if (this._resizeObserver) this._resizeObserver.disconnect()
      if (this._mutationObserver) this._mutationObserver.disconnect()
    }

    attributeChangedCallback() {
      if (!this.isConnected) return
      this._applySize()
      this._fit()
    }

    /** The slide elements, in order. */
    get slides() {
      return Array.from(this.children).filter((el) => el.localName === 'section')
    }

    get index() {
      return this._index
    }

    get length() {
      return this.slides.length
    }

    /** @param {number} n */
    goTo(n) {
      const total = this.slides.length
      if (!total) return
      const next = Math.max(0, Math.min(total - 1, Math.floor(Number(n) || 0)))
      if (next === this._index && this.slides[next]?.hasAttribute('data-deck-active')) return
      this._index = next
      this._sync()
    }

    next() {
      this.goTo(this._index + 1)
    }

    prev() {
      this.goTo(this._index - 1)
    }

    _width() {
      return size(this.getAttribute('width'), 1920)
    }

    _height() {
      return size(this.getAttribute('height'), 1080)
    }

    _applySize() {
      const w = this._width()
      const h = this._height()
      this.style.setProperty('--deck-w', `${w}px`)
      this.style.setProperty('--deck-h', `${h}px`)
      let page = document.getElementById('deck-stage-page')
      if (!page) {
        page = document.createElement('style')
        page.id = 'deck-stage-page'
        document.head.appendChild(page)
      }
      page.textContent = `@media print { @page { size: ${w}px ${h}px; margin: 0; } html, body { margin: 0 !important; padding: 0 !important; background: none !important; } }`
    }

    _fit() {
      const rect = this.getBoundingClientRect()
      const width = rect.width || window.innerWidth
      const height = rect.height || window.innerHeight
      const scale = Math.min(width / this._width(), height / this._height())
      this.style.setProperty('--deck-scale', String(Number.isFinite(scale) && scale > 0 ? scale : 1))
    }

    _restoredIndex() {
      const hash = /^#slide-(\d+)$/.exec(location.hash)
      if (hash) return Number(hash[1]) - 1
      const saved = /(?:^|\s)deck-stage:(\d+)(?:\s|$)/.exec(window.name || '')
      return saved ? Number(saved[1]) : 0
    }

    _remember() {
      const rest = (window.name || '').replace(/(?:^|\s)deck-stage:\d+(?=\s|$)/g, '').trim()
      window.name = `${rest ? `${rest} ` : ''}deck-stage:${this._index}`
    }

    _sync() {
      const slides = this.slides
      const total = slides.length
      if (this._index >= total) this._index = Math.max(0, total - 1)
      slides.forEach((slide, i) => {
        if (i === this._index) slide.setAttribute('data-deck-active', '')
        else slide.removeAttribute('data-deck-active')
      })
      const current = slides[this._index]
      const label = current ? current.getAttribute('data-label') : null
      this._counter.textContent = total ? `${this._index + 1} / ${total}${label ? ` · ${label}` : ''}` : '0 / 0'
      this._prevButton.disabled = this._index <= 0
      this._nextButton.disabled = this._index >= total - 1
      if (total) this._remember()
      if (this._announced !== `${this._index}/${total}`) {
        this._announced = `${this._index}/${total}`
        this.dispatchEvent(
          new CustomEvent('slidechange', {
            bubbles: true,
            detail: {
              index: this._index,
              total,
              label,
              notes: current ? current.getAttribute('data-speaker-notes') : null
            }
          })
        )
      }
    }

    _showHud() {
      this.setAttribute('data-deck-hud', '')
      clearTimeout(this._hudTimer)
      this._hudTimer = window.setTimeout(() => this.removeAttribute('data-deck-hud'), 1600)
    }

    /** @param {KeyboardEvent} event */
    _onKey(event) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = /** @type {HTMLElement | null} */ (event.target)
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable]')) return
      const key = event.key
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter') this.next()
      else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') this.prev()
      else if (key === 'Home') this.goTo(0)
      else if (key === 'End') this.goTo(this.slides.length - 1)
      else return
      event.preventDefault()
      this._showHud()
    }

    /** @param {MouseEvent} event */
    _onClick(event) {
      if (event.defaultPrevented || event.button !== 0) return
      const path = event.composedPath()
      if (path.some((node) => node instanceof Element && node.matches(INTERACTIVE) && this.contains(node))) return
      const rect = this.getBoundingClientRect()
      if (event.clientX < rect.left + rect.width / 3) this.prev()
      else this.next()
    }
  }

  customElements.define('deck-stage', DeckStage)
})()
