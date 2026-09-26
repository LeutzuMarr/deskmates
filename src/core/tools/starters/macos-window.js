/**
 * <macos-window title="Notes" width="900" height="600" dark> — desktop window chrome with
 * traffic lights and a centered title. The children fill the window below the title bar.
 */
;(() => {
  if (customElements.get('macos-window')) return

  const STYLE = `
    :host { display: inline-block; --win-w: 900px; --win-h: 600px; }
    .window {
      display: flex; flex-direction: column; width: var(--win-w); height: var(--win-h);
      border-radius: 12px; overflow: hidden; background: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12), 0 22px 70px rgba(0, 0, 0, 0.28);
    }
    :host([dark]) .window { background: #1e1e1e; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 22px 70px rgba(0, 0, 0, 0.5); }
    .bar {
      position: relative; flex: none; height: 38px; display: flex; align-items: center; padding: 0 14px;
      background: #ececec; border-bottom: 1px solid rgba(0, 0, 0, 0.1);
      font: 600 13px/1 -apple-system, "SF Pro Text", system-ui, sans-serif; color: #3c3c3c;
    }
    :host([dark]) .bar { background: #2b2b2b; border-color: rgba(255, 255, 255, 0.08); color: #d6d6d6; }
    .lights { display: flex; gap: 8px; }
    .lights span { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.2); }
    .lights span:nth-child(1) { background: #ff5f57; }
    .lights span:nth-child(2) { background: #febc2e; }
    .lights span:nth-child(3) { background: #28c840; }
    .title { position: absolute; left: 80px; right: 80px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .content { position: relative; flex: 1; min-height: 0; overflow: auto; }
  `

  class MacosWindow extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'title']
    }

    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
        <div class="window" part="window">
          <div class="bar" part="title-bar"><div class="lights"><span></span><span></span><span></span></div><div class="title"></div></div>
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
      this.style.setProperty('--win-w', `${parseFloat(this.getAttribute('width') || '') || 900}px`)
      this.style.setProperty('--win-h', `${parseFloat(this.getAttribute('height') || '') || 600}px`)
      this.shadowRoot.querySelector('.title').textContent = this.getAttribute('title') || ''
    }
  }

  customElements.define('macos-window', MacosWindow)
})()
