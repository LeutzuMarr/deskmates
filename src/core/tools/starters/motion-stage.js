/**
 * <motion-stage width="1920" height="1080" fps="30"> — a timeline animation engine for motion
 * graphics and animated videos.
 *
 * One clock drives everything. The piece is a list of scenes (name + duration) played back to back;
 * children are positioned on a width × height canvas (scaled to fit the window) and animate from
 * keyframes whose times name a scene, so elements persist and move across scene boundaries.
 *
 * Scenes, as a JSON string literal in a plain inline <script> of the page:
 *   <script>window.MOTION_SCENES = '[{"name":"Intro","duration":3},{"name":"Outro","duration":2}]'</script>
 * (or a `scenes` attribute, or <script type="application/json" id="motion-scenes">).
 *
 * Animating a child:
 *   data-motion="t:Intro; opacity:0; y:40 | t:Intro+0.6; opacity:1; y:0; ease:outCubic"
 *     keyframes split by |, properties by ;  (a JSON array of keyframe objects works too).
 *     t: seconds (2.5), a scene name (its start), Scene+0.4, Scene-0.2, Scene.end, Scene.end-0.5, Scene@50%.
 *     ease: on a keyframe, shapes the move INTO it. linear, in/out/inOut + Quad Cubic Quart Quint Sine
 *     Expo Circ Back Elastic Bounce (outCubic, inOutBack…), spring, cubic-bezier(a,b,c,d).
 *     properties: x y (px) scale scaleX scaleY rotate skewX skewY (deg) opacity blur (px) reveal
 *     revealY (0–1 wipes) typewriter (0–1 of the text), and any CSS property (color, width,
 *     background-color, letter-spacing…) — numbers with the same unit and colors interpolate.
 *   data-in="fade-up" data-in-at="Intro+0.2" data-in-dur="0.6"   entrance preset
 *   data-out="fade" data-out-at="Intro.end-0.4" data-out-dur="0.4"  exit preset
 *     presets: fade fade-up fade-down slide-left slide-right scale pop blur wipe wipe-up type
 *   data-scene="Intro"   only visible during that scene; its data-in/out default to the scene's start/end.
 *   data-stagger="0.08"  on a parent: its children's default data-in times step by this much.
 * Position children with left/top (position:absolute); the engine owns their transform.
 *
 * Script: stage.onFrame((time, info) => { … }) runs every frame (info: scene, sceneTime, progress);
 * stage.play(), pause(), seek(seconds), toggle(); stage.time, stage.duration, stage.scenes.
 * Motion.ease.outCubic(p) and Motion.tween(time, [t0, t1], [from, to], 'outCubic') help custom code.
 */
;(() => {
  if (customElements.get('motion-stage')) return

  // ---- Easing ----
  const cubicBezier = (x1, y1, x2, y2) => {
    const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3
    const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3
    const dx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t ** 2
    return (x) => {
      if (x <= 0) return 0
      if (x >= 1) return 1
      let t = x
      for (let i = 0; i < 8; i++) {
        const d = dx(t)
        if (Math.abs(d) < 1e-6) break
        t -= (bx(t) - x) / d
      }
      t = Math.min(1, Math.max(0, t))
      return by(t)
    }
  }
  const ease = { linear: (t) => t }
  const family = (name, fns) => {
    ease['in' + name] = fns[0]
    ease['out' + name] = fns[1]
    ease['inOut' + name] = fns[2]
  }
  const power = (p) => [(t) => t ** p, (t) => 1 - (1 - t) ** p, (t) => (t < 0.5 ? 2 ** (p - 1) * t ** p : 1 - (-2 * t + 2) ** p / 2)]
  family('Quad', power(2))
  family('Cubic', power(3))
  family('Quart', power(4))
  family('Quint', power(5))
  family('Sine', [(t) => 1 - Math.cos((t * Math.PI) / 2), (t) => Math.sin((t * Math.PI) / 2), (t) => -(Math.cos(Math.PI * t) - 1) / 2])
  family('Expo', [
    (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
    (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
    (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2)
  ])
  family('Circ', [
    (t) => 1 - Math.sqrt(1 - t * t),
    (t) => Math.sqrt(1 - (t - 1) ** 2),
    (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2)
  ])
  const c1 = 1.70158
  const c2 = c1 * 1.525
  const c3 = c1 + 1
  family('Back', [
    (t) => c3 * t ** 3 - c1 * t ** 2,
    (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
    (t) => (t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2)
  ])
  const c4 = (2 * Math.PI) / 3
  const c5 = (2 * Math.PI) / 4.5
  family('Elastic', [
    (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * c4)),
    (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
    (t) =>
      t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2 : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1
  ])
  const bounceOut = (t) => {
    const n = 7.5625
    const d = 2.75
    if (t < 1 / d) return n * t * t
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
    return n * (t -= 2.625 / d) * t + 0.984375
  }
  family('Bounce', [(t) => 1 - bounceOut(1 - t), bounceOut, (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2)])
  ease.spring = (t) => (t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(10 * t))
  ease.ease = cubicBezier(0.25, 0.1, 0.25, 1)
  ease.easeIn = cubicBezier(0.42, 0, 1, 1)
  ease.easeOut = cubicBezier(0, 0, 0.58, 1)
  ease.easeInOut = cubicBezier(0.42, 0, 0.58, 1)
  ease.in = ease.inCubic
  ease.out = ease.outCubic
  ease.inOut = ease.inOutCubic

  const easeIndex = new Map(Object.keys(ease).map((key) => [key.toLowerCase(), ease[key]]))
  const easeOf = (name) => {
    if (typeof name === 'function') return name
    if (!name) return ease.inOutCubic
    const text = String(name).trim()
    const bezier = /^cubic-bezier\(([^)]+)\)$/i.exec(text)
    if (bezier) {
      const [a, b, c, d] = bezier[1].split(',').map(Number)
      if ([a, b, c, d].every(Number.isFinite)) return cubicBezier(a, b, c, d)
    }
    return easeIndex.get(text.toLowerCase().replace(/[-_\s]/g, '').replace(/^ease(?=in|out)/, '')) || ease.inOutCubic
  }

  // ---- Values ----
  const TRANSFORMS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY']
  const SPECIAL = new Set([...TRANSFORMS, 'opacity', 'blur', 'reveal', 'revealY', 'typewriter'])
  const REST = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1, blur: 0, reveal: 1, revealY: 1, typewriter: 1 }

  const parseColor = (text) => {
    const s = String(text).trim()
    let m = /^#([0-9a-f]{3,8})$/i.exec(s)
    if (m) {
      let h = m[1]
      if (h.length === 3 || h.length === 4) h = h.replace(/./g, (c) => c + c)
      if (h.length !== 6 && h.length !== 8) return null
      const n = (i) => parseInt(h.slice(i, i + 2), 16)
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s)
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat)
      if (parts.length >= 3 && parts.every(Number.isFinite)) return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
    }
    return null
  }
  const parseValue = (raw) => {
    if (typeof raw === 'number') return { kind: 'num', n: raw, unit: '' }
    const text = String(raw).trim()
    const num = /^(-?\d*\.?\d+(?:e-?\d+)?)([a-z%]*)$/i.exec(text)
    if (num) return { kind: 'num', n: parseFloat(num[1]), unit: num[2] }
    const color = parseColor(text)
    if (color) return { kind: 'color', c: color }
    return { kind: 'raw', text }
  }
  const mix = (a, b, p) => {
    if (a.kind === 'num' && b.kind === 'num' && (a.unit === b.unit || !a.unit || !b.unit)) {
      return { kind: 'num', n: a.n + (b.n - a.n) * p, unit: a.unit || b.unit }
    }
    if (a.kind === 'color' && b.kind === 'color') return { kind: 'color', c: a.c.map((v, i) => v + (b.c[i] - v) * p) }
    return p < 1 ? a : b
  }
  const show = (v) => {
    if (v.kind === 'num') return `${Math.round(v.n * 1000) / 1000}${v.unit}`
    if (v.kind === 'color') return `rgba(${v.c.slice(0, 3).map((x) => Math.round(x)).join(', ')}, ${Math.round(v.c[3] * 1000) / 1000})`
    return v.text
  }
  const kebab = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

  // ---- Scenes and times ----
  const readScenes = (stage) => {
    let raw = stage.getAttribute('scenes') ?? window.MOTION_SCENES
    if (raw == null) raw = document.getElementById('motion-scenes')?.textContent
    let list = []
    try {
      list = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
    } catch (error) {
      console.error('motion-stage: the scene list is not valid JSON.', error)
    }
    if (!Array.isArray(list)) list = []
    let start = 0
    const scenes = []
    for (const [index, item] of list.entries()) {
      const duration = Math.max(0, Number(item && item.duration) || 0)
      scenes.push({ name: String((item && item.name) || `Scene ${index + 1}`), start, duration, end: start + duration })
      start += duration
    }
    return scenes
  }

  const resolveTime = (spec, scenes, fallback) => {
    if (spec == null || spec === '') return fallback
    if (typeof spec === 'number') return spec
    const text = String(spec).trim()
    if (/^-?\d*\.?\d+s?$/.test(text)) return parseFloat(text)
    const m = /^(.+?)(\.end)?(?:@(-?\d*\.?\d+)%)?\s*(?:([+-])\s*(\d*\.?\d+)s?)?$/.exec(text)
    if (m) {
      const scene = scenes.find((s) => s.name === m[1].trim()) || scenes.find((s) => s.name.toLowerCase() === m[1].trim().toLowerCase())
      if (scene) {
        let t = m[2] ? scene.end : scene.start
        if (m[3] != null) t = scene.start + (scene.duration * parseFloat(m[3])) / 100
        if (m[4]) t += (m[4] === '-' ? -1 : 1) * parseFloat(m[5])
        return t
      }
    }
    console.warn(`motion-stage: can't read the time "${text}".`)
    return fallback
  }

  /** Keyframes from JSON (array of objects) or the short form "t:0; opacity:0 | t:1; opacity:1". */
  const parseKeyframes = (text) => {
    const source = (text || '').trim()
    if (!source) return []
    if (source.startsWith('[')) {
      try {
        const list = JSON.parse(source)
        return Array.isArray(list) ? list.filter((k) => k && typeof k === 'object') : []
      } catch (error) {
        console.error('motion-stage: data-motion is not valid JSON.', error)
        return []
      }
    }
    return source
      .split('|')
      .map((frame) => {
        const out = {}
        for (const pair of frame.split(';')) {
          const at = pair.indexOf(':')
          if (at < 0) continue
          const key = pair.slice(0, at).trim()
          const value = pair.slice(at + 1).trim()
          if (key) out[key] = value
        }
        return out
      })
      .filter((k) => Object.keys(k).length > 0)
  }

  const PRESETS = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    'fade-up': [{ opacity: 0, y: 40 }, { opacity: 1, y: 0 }],
    'fade-down': [{ opacity: 0, y: -40 }, { opacity: 1, y: 0 }],
    'slide-left': [{ opacity: 0, x: 120 }, { opacity: 1, x: 0 }],
    'slide-right': [{ opacity: 0, x: -120 }, { opacity: 1, x: 0 }],
    scale: [{ opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1 }],
    pop: [{ opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, ease: 'outBack' }],
    blur: [{ opacity: 0, blur: 18 }, { opacity: 1, blur: 0 }],
    wipe: [{ reveal: 0 }, { reveal: 1 }],
    'wipe-up': [{ revealY: 0 }, { revealY: 1 }],
    type: [{ typewriter: 0 }, { typewriter: 1, ease: 'linear' }]
  }

  // ---- Tracks ----
  /** Builds per-property tracks for one element: [{ t, value, ease }] sorted by time. */
  const buildTracks = (el, scenes, total) => {
    const tracks = new Map()
    const add = (prop, t, value, easeName) => {
      if (prop === 't' || prop === 'ease' || value == null || value === '') return
      if (!tracks.has(prop)) tracks.set(prop, [])
      tracks.get(prop).push({ t, value: parseValue(value), ease: easeOf(easeName) })
    }
    for (const frame of parseKeyframes(el.getAttribute('data-motion'))) {
      const t = resolveTime(frame.t ?? frame.time ?? frame.at, scenes, 0)
      for (const [prop, value] of Object.entries(frame)) add(prop, t, value, frame.ease)
    }
    const sceneName = el.getAttribute('data-scene')
    const scene = sceneName ? scenes.find((s) => s.name === sceneName) : null
    const stagger = (() => {
      const parent = el.parentElement
      const step = parent && Number(parent.getAttribute('data-stagger'))
      if (!step) return 0
      const siblings = [...parent.children].filter((child) => child.hasAttribute('data-in'))
      return Math.max(0, siblings.indexOf(el)) * step
    })()
    const preset = (kind) => {
      const name = el.getAttribute(`data-${kind}`)
      if (!name) return
      const frames = PRESETS[name.trim()]
      if (!frames) {
        console.warn(`motion-stage: unknown ${kind} preset "${name}". Use one of: ${Object.keys(PRESETS).join(', ')}.`)
        return
      }
      const dur = Math.max(0.01, Number(el.getAttribute(`data-${kind}-dur`)) || 0.6)
      const easeName = el.getAttribute(`data-${kind}-ease`)
      if (kind === 'in') {
        const t = resolveTime(el.getAttribute('data-in-at'), scenes, (scene ? scene.start : 0) + stagger)
        for (const [prop, value] of Object.entries(frames[0])) if (prop !== 'ease') add(prop, t, value)
        for (const [prop, value] of Object.entries(frames[1])) if (prop !== 'ease') add(prop, t + dur, value, easeName || frames[1].ease || 'outCubic')
      } else {
        const t = resolveTime(el.getAttribute('data-out-at'), scenes, (scene ? scene.end : total) - dur)
        for (const [prop, value] of Object.entries(frames[1])) if (prop !== 'ease') add(prop, t, value)
        for (const [prop, value] of Object.entries(frames[0])) if (prop !== 'ease') add(prop, t + dur, value, easeName || 'inCubic')
      }
    }
    preset('in')
    preset('out')
    for (const list of tracks.values()) list.sort((a, b) => a.t - b.t)
    return { tracks, scene }
  }

  const sample = (list, time) => {
    if (time <= list[0].t) return list[0].value
    const last = list[list.length - 1]
    if (time >= last.t) return last.value
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (time >= a.t && time < b.t) {
        const span = b.t - a.t
        return span <= 0 ? b.value : mix(a.value, b.value, b.ease((time - a.t) / span))
      }
    }
    return last.value
  }

  const applyTracks = (el, info, time) => {
    const { tracks, scene } = info
    if (scene) el.style.visibility = time >= scene.start && (time < scene.end || scene.end >= info.total) ? '' : 'hidden'
    if (tracks.size === 0) return
    const v = {}
    for (const [prop, list] of tracks) v[prop] = sample(list, time)
    const num = (prop) => (v[prop] && v[prop].kind === 'num' ? v[prop].n : REST[prop])
    if (TRANSFORMS.some((p) => tracks.has(p))) {
      const unit = (prop, fallback) => (v[prop] && v[prop].kind === 'num' && v[prop].unit ? v[prop].unit : fallback)
      const scale = num('scale')
      el.style.transform =
        `translate(${num('x')}${unit('x', 'px')}, ${num('y')}${unit('y', 'px')}) rotate(${num('rotate')}deg) ` +
        `skew(${num('skewX')}deg, ${num('skewY')}deg) scale(${scale * num('scaleX')}, ${scale * num('scaleY')})`
    }
    if (tracks.has('opacity')) el.style.opacity = String(Math.min(1, Math.max(0, num('opacity'))))
    if (tracks.has('blur')) el.style.filter = `blur(${Math.max(0, num('blur'))}px)`
    if (tracks.has('reveal') || tracks.has('revealY')) {
      const rx = Math.min(1, Math.max(0, num('reveal')))
      const ry = Math.min(1, Math.max(0, num('revealY')))
      el.style.clipPath = `inset(0 ${(1 - rx) * 100}% ${(1 - ry) * 100}% 0)`
    }
    if (tracks.has('typewriter')) {
      if (el.__motionText == null) el.__motionText = el.textContent || ''
      const full = el.__motionText
      const count = Math.round(Math.min(1, Math.max(0, num('typewriter'))) * full.length)
      const next = full.slice(0, count)
      if (el.textContent !== next) el.textContent = next
    }
    for (const [prop] of tracks) if (!SPECIAL.has(prop)) el.style.setProperty(prop.startsWith('--') ? prop : kebab(prop), show(v[prop]))
  }

  // ---- The element ----
  const params = new URLSearchParams(location.search)
  const recording = () => Boolean(window.__dmTime) || params.get('record') === '1'
  const exporting = params.get('export') === '1'

  const STYLE = `
    :host { position: fixed; inset: 0; display: block; overflow: hidden; background: #111110; --stage-w: 1920px; --stage-h: 1080px; --stage-scale: 1; }
    .viewport { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .canvas { position: relative; flex: none; width: var(--stage-w); height: var(--stage-h); transform: scale(var(--stage-scale)); overflow: hidden; background: var(--stage-bg, #ffffff); }
    .bar { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(760px, calc(100% - 32px)); display: flex; align-items: center; gap: 12px;
      padding: 8px 14px 8px 8px; border-radius: 16px; background: rgba(20, 20, 19, 0.82); color: #f0eee6; font: 12px/1.3 system-ui, sans-serif;
      backdrop-filter: blur(8px); transition: opacity 0.3s; z-index: 2147483647; }
    :host([data-idle]) .bar { opacity: 0; }
    :host([data-recording]) .bar, :host([controls="none"]) .bar { display: none; }
    button { all: unset; cursor: pointer; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: #d97757; color: #fff; flex: none; }
    button:focus-visible { outline: 2px solid #f0eee6; outline-offset: 2px; }
    .track { position: relative; flex: 1; height: 30px; cursor: pointer; touch-action: none; }
    .scenes { position: absolute; left: 0; right: 0; top: 4px; height: 12px; display: flex; gap: 2px; }
    .scene { flex: none; height: 100%; border-radius: 4px; background: rgba(240, 238, 230, 0.16); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 9px; line-height: 12px; padding: 0 4px; box-sizing: border-box; color: rgba(240, 238, 230, 0.7); }
    .scene.on { background: rgba(217, 119, 87, 0.45); color: #fff; }
    .rail { position: absolute; left: 0; right: 0; bottom: 5px; height: 3px; border-radius: 2px; background: rgba(240, 238, 230, 0.2); }
    .fill { position: absolute; left: 0; bottom: 5px; height: 3px; border-radius: 2px; background: #d97757; }
    .head { position: absolute; bottom: 1px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: #f0eee6; }
    .time { flex: none; font-variant-numeric: tabular-nums; color: rgba(240, 238, 230, 0.8); min-width: 92px; text-align: right; }
  `
  const PLAY = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.8v10.4L12 7z" fill="currentColor"/></svg>'
  const PAUSE = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor"/></svg>'
  const clock = (s) => {
    const whole = Math.max(0, s)
    const m = Math.floor(whole / 60)
    return `${m}:${(whole - m * 60).toFixed(1).padStart(4, '0')}`
  }

  class MotionStage extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'background', 'scenes', 'duration']
    }

    constructor() {
      super()
      this._time = 0
      this._playing = false
      this._frames = []
      this._infos = new Map()
      this._raf = 0
      const root = this.attachShadow({ mode: 'open' })
      root.innerHTML = `<style>${STYLE}</style>
        <div class="viewport"><div class="canvas" part="canvas"><slot></slot></div></div>
        <div class="bar" part="controls">
          <button type="button" class="play" aria-label="Play">${PLAY}</button>
          <div class="track" role="slider" tabindex="0" aria-label="Timeline" aria-valuemin="0">
            <div class="scenes"></div><div class="rail"></div><div class="fill"></div><div class="head"></div>
          </div>
          <span class="time"></span>
        </div>`
      this._canvas = root.querySelector('.canvas')
      this._button = root.querySelector('.play')
      this._track = root.querySelector('.track')
      this._scenesEl = root.querySelector('.scenes')
      this._fill = root.querySelector('.fill')
      this._head = root.querySelector('.head')
      this._timeEl = root.querySelector('.time')
      this._button.addEventListener('click', () => this.toggle())
      const seekFromPointer = (event) => {
        const box = this._track.getBoundingClientRect()
        this.seek(((event.clientX - box.left) / box.width) * this.duration)
      }
      this._track.addEventListener('pointerdown', (event) => {
        this._track.setPointerCapture(event.pointerId)
        this._wasPlaying = this._playing
        this.pause()
        seekFromPointer(event)
      })
      this._track.addEventListener('pointermove', (event) => {
        if (this._track.hasPointerCapture(event.pointerId)) seekFromPointer(event)
      })
      this._track.addEventListener('pointerup', () => {
        if (this._wasPlaying) this.play()
      })
      this._onKey = (event) => {
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
        const step = event.shiftKey ? 1 : 1 / this.fps
        if (event.key === ' ') this.toggle()
        else if (event.key === 'ArrowRight') this.seek(this._time + step)
        else if (event.key === 'ArrowLeft') this.seek(this._time - step)
        else if (event.key === 'Home') this.seek(0)
        else if (event.key === 'End') this.seek(this.duration)
        else return
        event.preventDefault()
      }
      this._onMove = () => {
        this.removeAttribute('data-idle')
        clearTimeout(this._idleTimer)
        this._idleTimer = setTimeout(() => {
          if (this._playing) this.setAttribute('data-idle', '')
        }, 2000)
      }
      this._onResize = () => this._fit()
    }

    get width() {
      return Number(this.getAttribute('width')) || 1920
    }
    get height() {
      return Number(this.getAttribute('height')) || 1080
    }
    get fps() {
      return Math.min(60, Math.max(1, Number(this.getAttribute('fps')) || 30))
    }
    get scenes() {
      return this._scenes.map((s) => ({ ...s }))
    }
    get duration() {
      const own = Number(this.getAttribute('duration'))
      if (own > 0) return own
      const end = this._scenes.length ? this._scenes[this._scenes.length - 1].end : 0
      return end > 0 ? end : 5
    }
    get time() {
      return this._time
    }
    get playing() {
      return this._playing
    }

    connectedCallback() {
      this._scenes = readScenes(this)
      if (recording()) this.setAttribute('data-recording', '')
      this._fit()
      this._drawScenes()
      window.addEventListener('resize', this._onResize)
      window.addEventListener('keydown', this._onKey)
      this.addEventListener('pointermove', this._onMove)
      // Children added later (a Design Component renders after load) get their tracks too.
      this._observer = new MutationObserver((records) => {
        if (records.every((record) => record.target.__motionText != null)) return
        if (this._refreshQueued) return
        this._refreshQueued = true
        queueMicrotask(() => {
          this._refreshQueued = false
          this.refresh()
        })
      })
      this._observer.observe(this, { childList: true, subtree: true })
      if (!window.__deskmatesVideo) {
        window.__deskmatesVideo = {
          width: this.width,
          height: this.height,
          fps: this.fps,
          duration: this.duration,
          seek: (t) => {
            this.seek(t)
            return Promise.resolve()
          }
        }
      }
      // Children may still be parsing; start once the document (and a DC render) has settled.
      const start = () => {
        this.refresh()
        const saved = recording() || exporting ? 0 : Number(this._storage('get'))
        this.seek(Number.isFinite(saved) && saved > 0 && saved < this.duration ? saved : 0)
        if (!recording() && !exporting && this.getAttribute('autoplay') !== 'false') this.play()
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
      else queueMicrotask(start)
    }

    disconnectedCallback() {
      this.pause()
      window.removeEventListener('resize', this._onResize)
      window.removeEventListener('keydown', this._onKey)
      this.removeEventListener('pointermove', this._onMove)
      if (this._observer) this._observer.disconnect()
    }

    attributeChangedCallback() {
      if (!this.isConnected) return
      this._scenes = readScenes(this)
      this._fit()
      this._drawScenes()
      this.refresh()
    }

    /** Re-reads every child's keyframes (after editing data-motion or the scene list). */
    refresh() {
      this._scenes = readScenes(this)
      this._infos = new Map()
      for (const el of this.querySelectorAll('[data-motion], [data-in], [data-out], [data-scene]')) {
        const info = buildTracks(el, this._scenes, this.duration)
        info.total = this.duration
        info.source = [el.getAttribute('data-motion'), el.getAttribute('data-in'), el.getAttribute('data-out'), el.getAttribute('data-scene')].join('\u0000')
        this._infos.set(el, info)
      }
      if (window.__deskmatesVideo && window.__deskmatesVideo.seek) window.__deskmatesVideo.duration = this.duration
      this._drawScenes()
      this._render()
    }

    onFrame(callback) {
      if (typeof callback === 'function') this._frames.push(callback)
      this._render()
      return () => {
        this._frames = this._frames.filter((fn) => fn !== callback)
      }
    }

    play() {
      if (this._playing) return
      if (this._time >= this.duration) this._time = 0
      this._playing = true
      this._button.innerHTML = PAUSE
      this._button.setAttribute('aria-label', 'Pause')
      let last = performance.now()
      const tick = (now) => {
        if (!this._playing) return
        const delta = Math.max(0, (now - last) / 1000)
        last = now
        let next = this._time + delta
        if (next >= this.duration) {
          if (this.getAttribute('loop') === 'false') {
            this._time = this.duration
            this._render()
            this.pause()
            return
          }
          next %= this.duration
        }
        this._time = next
        this._render()
        this._raf = requestAnimationFrame(tick)
      }
      this._raf = requestAnimationFrame(tick)
      this._onMove()
    }

    pause() {
      this._playing = false
      cancelAnimationFrame(this._raf)
      this._button.innerHTML = PLAY
      this._button.setAttribute('aria-label', 'Play')
      this.removeAttribute('data-idle')
      this._storage('set', this._time)
    }

    toggle() {
      if (this._playing) this.pause()
      else this.play()
    }

    seek(seconds) {
      const t = Math.min(this.duration, Math.max(0, Number(seconds) || 0))
      this._time = t
      this._render()
      if (!this._playing) this._storage('set', t)
    }

    /** The scene playing at `time`, with its local time and 0–1 progress. */
    sceneAt(time = this._time) {
      const scene = this._scenes.find((s) => time >= s.start && time < s.end) || this._scenes[this._scenes.length - 1] || null
      if (!scene) return { scene: null, sceneTime: time, progress: this.duration ? time / this.duration : 0 }
      return { scene: scene.name, sceneTime: time - scene.start, progress: scene.duration ? Math.min(1, (time - scene.start) / scene.duration) : 1 }
    }

    _render() {
      const time = this._time
      for (const [el, info] of this._infos) {
        if (!el.isConnected) {
          this._infos.delete(el)
          continue
        }
        const source = [el.getAttribute('data-motion'), el.getAttribute('data-in'), el.getAttribute('data-out'), el.getAttribute('data-scene')].join('\u0000')
        if (source !== info.source) {
          const fresh = buildTracks(el, this._scenes, this.duration)
          Object.assign(info, fresh, { source, total: this.duration })
        }
        applyTracks(el, info, time)
      }
      const where = this.sceneAt(time)
      for (const fn of this._frames) {
        try {
          fn(time, where)
        } catch (error) {
          console.error(error)
        }
      }
      this.dispatchEvent(new CustomEvent('frame', { detail: { time, ...where } }))
      const share = this.duration ? (time / this.duration) * 100 : 0
      this._fill.style.width = `${share}%`
      this._head.style.left = `${share}%`
      this._track.setAttribute('aria-valuemax', String(this.duration))
      this._track.setAttribute('aria-valuenow', String(Math.round(time * 100) / 100))
      this._timeEl.textContent = `${clock(time)} / ${clock(this.duration)}`
      for (const [index, el] of [...this._scenesEl.children].entries()) {
        el.classList.toggle('on', this._scenes[index] && this._scenes[index].name === where.scene)
      }
    }

    _drawScenes() {
      const total = this.duration
      this._scenesEl.innerHTML = ''
      for (const scene of this._scenes) {
        const el = document.createElement('div')
        el.className = 'scene'
        el.style.width = `calc(${(scene.duration / total) * 100}% - 2px)`
        el.textContent = scene.name
        el.title = `${scene.name} · ${clock(scene.start)}–${clock(scene.end)}`
        this._scenesEl.appendChild(el)
      }
    }

    _fit() {
      const w = this.width
      const h = this.height
      this.style.setProperty('--stage-w', `${w}px`)
      this.style.setProperty('--stage-h', `${h}px`)
      const bg = this.getAttribute('background')
      if (bg) this.style.setProperty('--stage-bg', bg)
      const scale = Math.min(window.innerWidth / w, window.innerHeight / h)
      this.style.setProperty('--stage-scale', String(scale > 0 && Number.isFinite(scale) ? scale : 1))
    }

    _storage(action, value) {
      if (recording() || exporting) return null
      const key = `motion-stage:${location.pathname}`
      try {
        if (action === 'get') return localStorage.getItem(key)
        localStorage.setItem(key, String(Math.round(value * 1000) / 1000))
      } catch {
        // Storage can be unavailable (sandboxed previews).
      }
      return null
    }
  }

  customElements.define('motion-stage', MotionStage)
  window.Motion = {
    ease,
    easing: easeOf,
    /** Value at `time` along keyframe `times` (seconds) and `values` (numbers), eased per segment. */
    tween(time, times, values, easing) {
      const fn = easeOf(easing)
      if (time <= times[0]) return values[0]
      for (let i = 0; i < times.length - 1; i++) {
        if (time < times[i + 1]) return values[i] + (values[i + 1] - values[i]) * fn((time - times[i]) / (times[i + 1] - times[i]))
      }
      return values[values.length - 1]
    }
  }
})()
