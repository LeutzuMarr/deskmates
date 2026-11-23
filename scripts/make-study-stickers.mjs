// Draws Deskmates' own stickers (labels in Romanian, maths and chemistry symbols, solid shapes),
// as small SVG files next to the Fluent ones: src/renderer/remote-public/store/stickers/<pack>/dm-*.svg
//   node scripts/make-study-stickers.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = join(import.meta.dirname, '..', 'src', 'renderer', 'remote-public', 'store', 'stickers')
const FONT = "'Avenir Next', 'Helvetica Neue', Arial, sans-serif"

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const shadow = `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".22"/></filter></defs>`

function label(text, fill, ink = '#fff', tilt = -3) {
  const size = 30
  const width = Math.round(text.length * size * 0.62 + 56)
  const h = 66
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width + 16} ${h + 20}" width="${width + 16}" height="${h + 20}">${shadow}
<g filter="url(#s)" transform="rotate(${tilt} ${(width + 16) / 2} ${(h + 20) / 2})">
<rect x="8" y="10" width="${width}" height="${h}" rx="${h / 2}" fill="#fff"/>
<rect x="13" y="15" width="${width - 10}" height="${h - 10}" rx="${(h - 10) / 2}" fill="${fill}"/>
<text x="${(width + 16) / 2}" y="${10 + h / 2 + size * 0.36}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${size}" fill="${ink}">${esc(text)}</text>
</g></svg>`
}

function bubble(symbol, fill, size = 44) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">${shadow}
<g filter="url(#s)"><circle cx="60" cy="58" r="50" fill="#fff"/><circle cx="60" cy="58" r="44" fill="${fill}"/>
<circle cx="44" cy="40" r="12" fill="#fff" opacity=".18"/>
<text x="60" y="${58 + size * 0.36}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${size}" fill="#fff">${esc(symbol)}</text></g></svg>`
}

function lineArt(paths, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">${shadow}
<g filter="url(#s)" fill="none" stroke-linecap="round" stroke-linejoin="round">
<g stroke="#fff" stroke-width="13">${paths}</g>
<g stroke="${color}" stroke-width="5">${paths}</g></g></svg>`
}

const STICKERS = {
  study: {
    'dm-important': label('Important!', '#e03131'),
    'dm-de-retinut': label('De reținut', '#f2711c'),
    'dm-definitie': label('Definiție', '#1f4fd1'),
    'dm-exemplu': label('Exemplu', '#0f9d76'),
    'dm-formula': label('Formulă', '#8e44ad'),
    'dm-tema': label('Temă', '#2f80ed', '#fff', 3),
    'dm-test': label('Test', '#d6336c', '#fff', 4),
    'dm-bravo': label('Bravo!', '#f2b705', '#3a2a00', 5),
    'dm-nu-uita': label('Nu uita!', '#e03131', '#fff', 2),
    'dm-recapitulare': label('Recapitulare', '#5f7249'),
    'dm-intrebare': label('Întrebare?', '#4b7fb8'),
    'dm-atentie': label('Atenție!', '#f2b705', '#3a2a00', -2),
    'dm-teorema': label('Teoremă', '#7a4a78'),
    'dm-concluzie': label('Concluzie', '#0f9d76', '#fff', 2),
    'dm-arrow': lineArt('<path d="M18 86 C 34 30, 78 26, 100 44"/><path d="M84 36 L 101 44 L 92 60"/>', '#e03131'),
    'dm-arrow-straight': lineArt('<path d="M16 60 H 100"/><path d="M84 44 L 102 60 L 84 76"/>', '#1f4fd1'),
    'dm-star-burst': lineArt('<path d="M60 14 L70 44 L102 46 L76 64 L86 96 L60 78 L34 96 L44 64 L18 46 L50 44 Z"/>', '#f2b705')
  },
  algebra: {
    'dm-pi': bubble('π', '#1f4fd1'),
    'dm-sqrt': bubble('√x', '#8e44ad', 38),
    'dm-sum': bubble('∑', '#0f9d76'),
    'dm-delta': bubble('Δ', '#e03131'),
    'dm-infinity': bubble('∞', '#f2711c', 50),
    'dm-square': bubble('x²', '#2f80ed', 40),
    'dm-function': bubble('f(x)', '#d6336c', 32),
    'dm-integral': bubble('∫', '#5f7249', 52),
    'dm-approx': bubble('≈', '#4b7fb8'),
    'dm-not-equal': bubble('≠', '#7a4a78'),
    'dm-percent': bubble('%', '#f2b705'),
    'dm-plus-minus': bubble('±', '#1f4fd1')
  },
  geometry: {
    'dm-triangle': lineArt('<path d="M60 18 L104 98 H16 Z"/>', '#1f4fd1'),
    'dm-right-triangle': lineArt('<path d="M20 20 V100 H100 Z"/><path d="M20 84 H36 V100"/>', '#0f9d76'),
    'dm-square-shape': lineArt('<rect x="22" y="22" width="76" height="76" rx="2"/>', '#e03131'),
    'dm-circle-radius': lineArt('<circle cx="60" cy="60" r="42"/><path d="M60 60 L 96 38"/><circle cx="60" cy="60" r="2"/>', '#8e44ad'),
    'dm-cube': lineArt('<path d="M30 42 L60 26 L92 42 L92 82 L60 98 L30 82 Z"/><path d="M30 42 L60 58 L92 42 M60 58 V98"/>', '#2f80ed'),
    'dm-pyramid': lineArt('<path d="M60 16 L100 92 L62 104 L20 90 Z"/><path d="M60 16 L62 104"/>', '#f2711c'),
    'dm-cylinder': lineArt('<ellipse cx="60" cy="28" rx="32" ry="11"/><path d="M28 28 V90 A32 11 0 0 0 92 90 V28"/>', '#5f7249'),
    'dm-angle': lineArt('<path d="M18 98 H104 M18 98 L86 28"/><path d="M48 98 A30 30 0 0 0 40 76"/>', '#d6336c'),
    'dm-hexagon': lineArt('<path d="M60 16 L98 38 V82 L60 104 L22 82 V38 Z"/>', '#4b7fb8')
  },
  sciences: {
    'dm-water': bubble('H₂O', '#2f80ed', 34),
    'dm-co2': bubble('CO₂', '#5b5b60', 34),
    'dm-o2': bubble('O₂', '#e03131', 40),
    'dm-nacl': bubble('NaCl', '#0f9d76', 30),
    'dm-ph': bubble('pH', '#8e44ad', 40),
    'dm-electron': bubble('e⁻', '#f2b705', 42),
    'dm-benzene': lineArt('<path d="M60 16 L98 38 V82 L60 104 L22 82 V38 Z"/><circle cx="60" cy="60" r="24"/>', '#0f9d76'),
    'dm-reaction-arrow': lineArt('<path d="M14 50 H100"/><path d="M88 40 L102 50"/><path d="M106 70 H20"/><path d="M32 80 L18 70"/>', '#d6336c')
  },
  physics: {
    'dm-velocity': bubble('v', '#1f4fd1', 52),
    'dm-force': bubble('F', '#e03131', 52),
    'dm-energy': bubble('E=mc²', '#8e44ad', 24),
    'dm-ohm': bubble('Ω', '#0f9d76', 50),
    'dm-lambda': bubble('λ', '#f2711c', 52),
    'dm-wave': lineArt('<path d="M10 60 C 22 30, 34 30, 46 60 S 70 90, 82 60 S 106 30, 112 46"/>', '#2f80ed'),
    'dm-vector': lineArt('<path d="M18 98 L96 26"/><path d="M76 26 H96 V46"/>', '#e03131')
  }
}

for (const [pack, stickers] of Object.entries(STICKERS)) {
  mkdirSync(join(out, pack), { recursive: true })
  for (const [name, svg] of Object.entries(stickers)) writeFileSync(join(out, pack, `${name}.svg`), svg)
}
console.log(`made ${Object.values(STICKERS).reduce((n, s) => n + Object.keys(s).length, 0)} stickers`)
