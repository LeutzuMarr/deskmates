/**
 * <ios-frame width="393" height="852" time="9:41" dark> — an iPhone-style bezel.
 *
 * The children fill the screen (width × height CSS pixels); the status bar and home indicator
 * float on top. Add `no-status-bar` to hide the status bar.
 */
;(() => {
  if (customElements.get('ios-frame')) return

  const STYLE = `
    :host { display: inline-block; --screen-w: 393px; --screen-h: 852px; --ink: #000; --bezel: #1c1c1e; }
    :host([dark]) { --ink: #fff; }
    .body {
      position: relative;
      width: var(--screen-w);
      height: var(--screen-h);
      padding: 12px;
      border-radius: 64px;
      background: var(--bezel);
      box-shadow: 0 0 0 2px #3a3a3c, 0 24px 60px rgba(0, 0, 0, 0.28);
    }
    .screen { position: relative; width: 100%; height: 100%; border-radius: 52px; overflow: hidden; background: #fff; }
    :host([dark]) .screen { background: #000; }
    .content { position: absolute; inset: 0; overflow: auto; }
    .island { position: absolute; top: 11px; left: 50%; width: 124px; height: 36px; transform: translateX(-50%); border-radius: 20px; background: #000; z-index: 3; }
    .status {
      position: absolute; top: 0; left: 0; right: 0; height: 54px; z-index: 2;
      display: flex; align-items: center; justify-content: space-between; padding: 4px 32px 0 44px;
      color: var(--ink); font: 600 17px/1 -apple-system, "SF Pro Text", system-ui, sans-serif; pointer-events: none;
    }
    :host([no-status-bar]) .status { display: none; }
    .icons { display: flex; gap: 6px; align-items: center; }
    .home { position: absolute; bottom: 8px; left: 50%; width: 140px; height: 5px; transform: translateX(-50%); border-radius: 3px; background: var(--ink); opacity: 0.85; z-index: 2; pointer-events: none; }
  `

  const ICONS = `
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3A10.4 10.4 0 0 0 8 .4 10.4 10.4 0 0 0 .8 3.3L2 4.6a8.6 8.6 0 0 1 6-2.4Zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.3-1.3A6.8 6.8 0 0 0 8 4a6.8 6.8 0 0 0-4.7 1.8l1.3 1.3c.9-.8 2.1-1.3 3.4-1.3Zm0 3.5c-.5 0-1 .2-1.3.5L8 11.2l1.3-1.4c-.3-.3-.8-.5-1.3-.5Z"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2Z" fill="currentColor" opacity="0.5"/></svg>`

  class IosFrame extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'time']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
        <div class="body" part="bezel"><div class="screen" part="screen">
          <div class="content"><slot></slot></div>
          <div class="status" part="status-bar"><span class="time"></span><span class="icons">${ICONS}</span></div>
          <div class="island"></div>
          <div class="home"></div>
        </div></div>`
    }

    connectedCallback() {
      this._render()
    }

    attributeChangedCallback() {
      this._render()
    }

    _render() {
      const w = parseFloat(this.getAttribute('width') || '') || 393
      const h = parseFloat(this.getAttribute('height') || '') || 852
      this.style.setProperty('--screen-w', `${w}px`)
      this.style.setProperty('--screen-h', `${h}px`)
      this.shadowRoot.querySelector('.time').textContent = this.getAttribute('time') || '9:41'
    }
  }

  customElements.define('ios-frame', IosFrame)
})()
