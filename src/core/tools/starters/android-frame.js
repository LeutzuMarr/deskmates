/**
 * <android-frame width="412" height="915" time="9:30" dark> — an Android phone bezel.
 *
 * The children fill the screen (width × height CSS pixels); the status bar and gesture bar
 * float on top. Add `no-status-bar` to hide the status bar.
 */
;(() => {
  if (customElements.get('android-frame')) return

  const STYLE = `
    :host { display: inline-block; --screen-w: 412px; --screen-h: 915px; --ink: #1f1f1f; }
    :host([dark]) { --ink: #f1f1f1; }
    .body {
      position: relative;
      width: var(--screen-w);
      height: var(--screen-h);
      padding: 10px;
      border-radius: 44px;
      background: #202124;
      box-shadow: 0 0 0 2px #3c4043, 0 24px 60px rgba(0, 0, 0, 0.28);
    }
    .screen { position: relative; width: 100%; height: 100%; border-radius: 34px; overflow: hidden; background: #fff; }
    :host([dark]) .screen { background: #000; }
    .content { position: absolute; inset: 0; overflow: auto; }
    .camera { position: absolute; top: 12px; left: 50%; width: 14px; height: 14px; transform: translateX(-50%); border-radius: 50%; background: #000; box-shadow: 0 0 0 2px #1a1a1a; z-index: 3; }
    .status {
      position: absolute; top: 0; left: 0; right: 0; height: 40px; z-index: 2;
      display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
      color: var(--ink); font: 500 14px/1 Roboto, system-ui, sans-serif; pointer-events: none;
    }
    :host([no-status-bar]) .status { display: none; }
    .icons { display: flex; gap: 6px; align-items: center; }
    .gesture { position: absolute; bottom: 8px; left: 50%; width: 108px; height: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--ink); opacity: 0.7; z-index: 2; pointer-events: none; }
  `

  const ICONS = `
    <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path d="M7.5 3a9 9 0 0 1 6.4 2.6L7.5 13 1.1 5.6A9 9 0 0 1 7.5 3Z"/></svg>
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M13 1v12H1Z"/></svg>
    <svg width="9" height="15" viewBox="0 0 9 15" fill="currentColor" aria-hidden="true"><rect x="0" y="2" width="9" height="13" rx="1.5"/><rect x="2.5" y="0" width="4" height="2" rx="0.5"/></svg>`

  class AndroidFrame extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'time']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
        <div class="body" part="bezel"><div class="screen" part="screen">
          <div class="content"><slot></slot></div>
          <div class="status" part="status-bar"><span class="time"></span><span class="icons">${ICONS}</span></div>
          <div class="camera"></div>
          <div class="gesture"></div>
        </div></div>`
    }

    connectedCallback() {
      this._render()
    }

    attributeChangedCallback() {
      this._render()
    }

    _render() {
      const w = parseFloat(this.getAttribute('width') || '') || 412
      const h = parseFloat(this.getAttribute('height') || '') || 915
      this.style.setProperty('--screen-w', `${w}px`)
      this.style.setProperty('--screen-h', `${h}px`)
      this.shadowRoot.querySelector('.time').textContent = this.getAttribute('time') || '9:30'
    }
  }

  customElements.define('android-frame', AndroidFrame)
})()
