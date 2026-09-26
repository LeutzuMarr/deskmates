/**
 * <image-slot id="hero" shape="rounded" radius="16" placeholder="Drop a product photo">
 * — an image placeholder the user fills by dropping or picking a file. Fills its container
 * unless width/height are given. shape: rect | rounded | circle | pill. `mask` takes a CSS
 * clip-path. The chosen image is kept per id where the page can use localStorage.
 */
;(() => {
  if (customElements.get('image-slot')) return

  const STYLE = `
    :host { display: block; position: relative; width: 100%; height: 100%; min-height: 48px; box-sizing: border-box; }
    .slot {
      position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center;
      background: repeating-linear-gradient(45deg, #f2f1ec, #f2f1ec 10px, #ebe9e2 10px, #ebe9e2 20px);
      border: 1.5px dashed #b9b6ab; color: #6b6a64; cursor: pointer; box-sizing: border-box;
      font: 500 13px/1.4 system-ui, sans-serif; text-align: center; padding: 12px;
    }
    .slot.over { border-color: #d97757; color: #d97757; }
    .slot.filled { border: 0; padding: 0; background: none; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; }
    input { display: none; }
  `

  const RADII = { rect: '0', rounded: '12px', circle: '50%', pill: '999px' }

  class ImageSlot extends HTMLElement {
    static get observedAttributes() {
      return ['shape', 'radius', 'mask', 'placeholder', 'width', 'height', 'src']
    }

    constructor() {
      super()
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = `<style>${STYLE}</style><div class="slot" part="slot"></div><input type="file" accept="image/*">`
      this._box = root.querySelector('.slot')
      this._input = root.querySelector('input')
      this._box.addEventListener('click', () => this._input.click())
      this._input.addEventListener('change', () => {
        if (this._input.files && this._input.files[0]) this._load(this._input.files[0])
      })
      this._box.addEventListener('dragover', (event) => {
        event.preventDefault()
        this._box.classList.add('over')
      })
      this._box.addEventListener('dragleave', () => this._box.classList.remove('over'))
      this._box.addEventListener('drop', (event) => {
        event.preventDefault()
        this._box.classList.remove('over')
        const file = event.dataTransfer && event.dataTransfer.files[0]
        if (file && file.type.startsWith('image/')) this._load(file)
      })
    }

    connectedCallback() {
      this._render()
    }

    attributeChangedCallback() {
      this._render()
    }

    _key() {
      return this.id ? `image-slot:${location.pathname}:${this.id}` : null
    }

    _saved() {
      const key = this._key()
      if (!key) return null
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    }

    /** @param {File} file */
    _load(file) {
      const reader = new FileReader()
      reader.onload = () => {
        this._image = String(reader.result)
        const key = this._key()
        if (key) {
          try {
            localStorage.setItem(key, this._image)
          } catch {
            // Sandboxed pages have no storage; the image stays until reload.
          }
        }
        this._render()
      }
      reader.readAsDataURL(file)
    }

    _render() {
      const shape = this.getAttribute('shape') || 'rect'
      const radius = this.getAttribute('radius')
      this._box.style.borderRadius = radius ? (/^\d+$/.test(radius) ? `${radius}px` : radius) : RADII[shape] || '0'
      this._box.style.clipPath = this.getAttribute('mask') || ''
      const width = this.getAttribute('width')
      const height = this.getAttribute('height')
      if (width) this.style.width = /^\d+$/.test(width) ? `${width}px` : width
      if (height) this.style.height = /^\d+$/.test(height) ? `${height}px` : height
      const src = this._image || this._saved() || this.getAttribute('src')
      this._box.classList.toggle('filled', !!src)
      this._box.textContent = ''
      if (src) {
        const img = document.createElement('img')
        img.src = src
        img.alt = this.getAttribute('placeholder') || ''
        this._box.appendChild(img)
      } else {
        this._box.textContent = this.getAttribute('placeholder') || 'Drop an image here'
      }
    }
  }

  customElements.define('image-slot', ImageSlot)
})()
