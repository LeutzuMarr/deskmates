/**
 * <browser-window url="https://example.com" tab-title="Example" width="1280" height="800" dark>
 * — browser chrome with one tab and an address bar. The children fill the page area.
 */
;(() => {
  if (customElements.get('browser-window')) return

  const STYLE = `
    :host { display: inline-block; --win-w: 1280px; --win-h: 800px; --chrome: #dee1e6; --tab: #fff; --ink: #3c4043; --field: #f1f3f4; }
    :host([dark]) { --chrome: #202124; --tab: #35363a; --ink: #e8eaed; --field: #202124; }
    .window {
      display: flex; flex-direction: column; width: var(--win-w); height: var(--win-h);
      border-radius: 10px; overflow: hidden; background: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.14), 0 22px 70px rgba(0, 0, 0, 0.26);
      font: 400 12px/1 system-ui, sans-serif; color: var(--ink);
    }
    .tabs { flex: none; height: 38px; display: flex; align-items: flex-end; gap: 12px; padding: 0 10px; background: var(--chrome); }
    .lights { display: flex; gap: 7px; align-self: center; margin-right: 8px; }
    .lights span { width: 11px; height: 11px; border-radius: 50%; }
    .lights span:nth-child(1) { background: #ff5f57; }
    .lights span:nth-child(2) { background: #febc2e; }
    .lights span:nth-child(3) { background: #28c840; }
    .tab {
      display: flex; align-items: center; gap: 8px; width: 220px; height: 30px; padding: 0 12px;
      border-radius: 8px 8px 0 0; background: var(--tab); white-space: nowrap; overflow: hidden;
    }
    .favicon { flex: none; width: 14px; height: 14px; border-radius: 3px; background: #8ab4f8; }
    .tab-title { overflow: hidden; text-overflow: ellipsis; }
    .toolbar { flex: none; height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: var(--tab); border-bottom: 1px solid rgba(0, 0, 0, 0.08); }
    .nav { display: flex; gap: 14px; font-size: 15px; opacity: 0.7; }
    .address { flex: 1; height: 28px; display: flex; align-items: center; padding: 0 14px; border-radius: 14px; background: var(--field); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
    .content { position: relative; flex: 1; min-height: 0; overflow: auto; background: #fff; }
  `

  class BrowserWindow extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'url', 'tab-title']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
        <div class="window" part="window">
          <div class="tabs"><div class="lights"><span></span><span></span><span></span></div>
            <div class="tab"><span class="favicon"></span><span class="tab-title"></span></div></div>
          <div class="toolbar"><div class="nav" aria-hidden="true"><span>&#8592;</span><span>&#8594;</span><span>&#8635;</span></div><div class="address"></div></div>
          <div class="content"><slot></slot></div>
        </div>`
    }

    connectedCallback() {
      this._render()
    }

    attributeChangedCallback() {
      this._render()
    }

    _render() {
      this.style.setProperty('--win-w', `${parseFloat(this.getAttribute('width') || '') || 1280}px`)
      this.style.setProperty('--win-h', `${parseFloat(this.getAttribute('height') || '') || 800}px`)
      const url = this.getAttribute('url') || 'https://example.com'
      this.shadowRoot.querySelector('.address').textContent = url.replace(/^https?:\/\//, '')
      this.shadowRoot.querySelector('.tab-title').textContent = this.getAttribute('tab-title') || url.replace(/^https?:\/\//, '').split('/')[0]
    }
  }

  customElements.define('browser-window', BrowserWindow)
})()
