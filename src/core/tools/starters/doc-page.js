/**
 * <doc-page size="letter|a4" orientation="portrait|landscape"> — a printable document shell.
 *
 * Flowing documents: write the content as normal HTML inside; it shows on one paper-width
 * sheet and print paginates it. Explicit pages: one <section class="page"> child per page;
 * each is a fixed page box (overflow hidden) and prints as one sheet. width/height (any
 * absolute CSS length) replace the paper size when the user gives an explicit size.
 */
;(() => {
  if (customElements.get('doc-page')) return

  const PAPER = { letter: ['8.5in', '11in'], a4: ['210mm', '297mm'] }

  const STYLE = `
    :host { display: block; min-height: 100vh; padding: 40px 0; box-sizing: border-box; background: #e8e6df; --page-w: 8.5in; --page-h: 11in; --margin: 0.75in; }
    .desk { display: flex; flex-direction: column; align-items: center; gap: 32px; }
    .sheet { width: var(--page-w); min-height: var(--page-h); padding: var(--margin); box-sizing: border-box; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14); }
    :host([data-paged]) .sheet { display: contents; }
    ::slotted(section.page) {
      width: var(--page-w) !important; height: var(--page-h) !important; box-sizing: border-box; overflow: hidden !important;
      background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14); margin: 0 auto 32px !important; position: relative;
    }
    @media print {
      :host { padding: 0 !important; background: none !important; min-height: 0 !important; }
      .desk { display: block; }
      .sheet { width: auto; min-height: 0; padding: 0; box-shadow: none; }
      ::slotted(section.page) { box-shadow: none !important; margin: 0 !important; break-after: page; page-break-after: always; }
      ::slotted(section.page:last-of-type) { break-after: auto; page-break-after: auto; }
    }
  `

  class DocPage extends HTMLElement {
    static get observedAttributes() {
      return ['size', 'orientation', 'width', 'height']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><div class="desk"><div class="sheet" part="sheet"><slot></slot></div></div>`
      this._observer = new MutationObserver(() => this._render())
    }

    connectedCallback() {
      this._observer.observe(this, { childList: true })
      this._render()
    }

    disconnectedCallback() {
      this._observer.disconnect()
    }

    attributeChangedCallback() {
      if (this.isConnected) this._render()
    }

    _render() {
      const paged = Array.from(this.children).some((el) => el.localName === 'section' && el.classList.contains('page'))
      this.toggleAttribute('data-paged', paged)
      const paper = PAPER[(this.getAttribute('size') || 'letter').toLowerCase()] || PAPER.letter
      let [w, h] = paper
      if ((this.getAttribute('orientation') || '').toLowerCase() === 'landscape') [w, h] = [h, w]
      w = this.getAttribute('width') || w
      h = this.getAttribute('height') || h
      this.style.setProperty('--page-w', w)
      this.style.setProperty('--page-h', h)
      let page = document.getElementById('doc-page-print')
      if (!page) {
        page = document.createElement('style')
        page.id = 'doc-page-print'
        document.head.appendChild(page)
      }
      page.textContent = `@media print { @page { size: ${w} ${h}; margin: ${paged ? '0' : '0.75in'}; } html, body { margin: 0 !important; background: none !important; } }`
    }
  }

  customElements.define('doc-page', DocPage)
})()
