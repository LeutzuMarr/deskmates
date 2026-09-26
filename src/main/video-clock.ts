/**
 * The page-side half of video recording. Injected before any of the page's own scripts, it replaces
 * the page's clock (timers, requestAnimationFrame, performance.now, Date) with one that only moves
 * when the recorder calls `__dmTime.advanceTo(ms)`. CSS animations and transitions, Web Animations,
 * SVG animations and <video> elements are paused and set to the same time, so every frame is exact
 * no matter how long it takes to capture.
 */
export const CLOCK_SCRIPT = `(() => {
  if (window.__dmTime) return
  const realRaf = window.requestAnimationFrame.bind(window)
  const realSetTimeout = window.setTimeout.bind(window)
  const RealDate = Date
  const epoch = RealDate.now()
  let now = 0
  let rafs = new Map()
  let rafSeq = 0
  const timers = new Map()
  let timerSeq = 0
  const starts = new WeakMap()

  const call = (fn, args) => {
    try {
      if (typeof fn === 'function') fn(...args)
      else (0, eval)(String(fn))
    } catch (error) {
      console.error(error)
    }
  }

  performance.now = () => now
  function FakeDate(...args) {
    if (!new.target) return new RealDate(epoch + now).toString()
    return args.length ? new RealDate(...args) : new RealDate(epoch + now)
  }
  FakeDate.prototype = RealDate.prototype
  FakeDate.now = () => epoch + now
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  window.Date = FakeDate

  window.requestAnimationFrame = (cb) => {
    const id = ++rafSeq
    rafs.set(id, cb)
    return id
  }
  window.cancelAnimationFrame = (id) => {
    rafs.delete(id)
  }
  window.setTimeout = (cb, ms, ...args) => {
    const id = ++timerSeq
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), every: 0, cb, args })
    return id
  }
  window.setInterval = (cb, ms, ...args) => {
    const id = ++timerSeq
    const every = Math.max(1, Number(ms) || 0)
    timers.set(id, { at: now + every, every, cb, args })
    return id
  }
  window.clearTimeout = window.clearInterval = (id) => {
    timers.delete(id)
  }

  const syncAnimations = () => {
    for (const animation of document.getAnimations()) {
      if (!starts.has(animation)) starts.set(animation, now)
      try {
        animation.pause()
        animation.currentTime = (now - starts.get(animation)) * (animation.playbackRate || 1)
      } catch {}
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.ownerSVGElement || typeof svg.setCurrentTime !== 'function') continue
      try {
        svg.pauseAnimations()
        svg.setCurrentTime(now / 1000)
      } catch {}
    }
  }

  const syncVideos = () => {
    const waits = []
    for (const video of document.querySelectorAll('video')) {
      const length = video.duration
      if (!Number.isFinite(length) || length <= 0) continue
      const target = video.loop ? (now / 1000) % length : Math.min(now / 1000, length)
      video.pause()
      if (Math.abs(video.currentTime - target) < 0.001) continue
      waits.push(new Promise((done) => {
        video.addEventListener('seeked', done, { once: true })
        realSetTimeout(done, 500)
      }))
      video.currentTime = target
    }
    return Promise.all(waits)
  }

  window.__dmTime = {
    now: () => now,
    realRaf,
    realSetTimeout,
    /** Runs every timer due up to \`target\` ms in order, then one animation frame at \`target\`. */
    async advanceTo(target) {
      for (let guard = 0; guard < 20000; guard++) {
        let nextId = null
        let next = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) {
            nextId = id
            next = timer
          }
        }
        if (!next) break
        now = Math.max(now, next.at)
        if (next.every) next.at += next.every
        else timers.delete(nextId)
        call(next.cb, next.args)
        await Promise.resolve()
      }
      now = Math.max(now, target)
      const due = rafs
      rafs = new Map()
      for (const cb of due.values()) call(cb, [now])
      await Promise.resolve()
      syncAnimations()
      await syncVideos()
    },
    /** Resolves after the browser has painted what the page currently shows. */
    painted() {
      return new Promise((done) => realRaf(() => realRaf(() => done(true))))
    }
  }
})()`

/** Puts the clock script first in the document: after <head> (or <html>), but after any doctype. */
export function injectClock(html: string): string {
  const tag = `<script>${CLOCK_SCRIPT}</script>`
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
  const root = /<html\b[^>]*>/i.exec(html)
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length)
  return tag + html
}
