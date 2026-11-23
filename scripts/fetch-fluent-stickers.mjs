// Downloads the Microsoft Fluent Emoji (MIT licence) used as stickers in the notes store, into
// src/renderer/remote-public/store/stickers/<pack>/. Run once after changing the lists:
//   node scripts/fetch-fluent-stickers.mjs
// The files are committed; the app never fetches from GitHub itself.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const FLUENT_PACKS = {
  algebra: ['Abacus', 'Input numbers', 'Input symbols', 'Infinity', 'Bar chart', 'Chart increasing', 'Chart decreasing', 'Coin', 'Light bulb', 'Thinking face', 'Hundred points', 'Check mark button', 'Red question mark'],
  geometry: ['Triangular ruler', 'Straight ruler', 'Compass', 'Pencil', 'Black nib', 'Magnifying glass tilted left', 'Round pushpin', 'Pushpin', 'World map', 'Globe showing europe-africa', 'Crystal ball'],
  physics: ['Magnet', 'Atom symbol', 'High voltage', 'Battery', 'Electric plug', 'Light bulb', 'Rocket', 'Satellite', 'Telescope', 'Ringed planet', 'Comet', 'Milky way', 'Sun', 'Crescent moon', 'Rainbow', 'Stopwatch', 'Thermometer', 'Balance scale', 'Gear', 'Snowflake', 'Cloud with lightning'],
  sciences: ['Test tube', 'Alembic', 'Petri dish', 'Microscope', 'Goggles', 'Lab coat', 'Scientist', 'Fire', 'Droplet', 'Bubbles', 'Rock', 'Volcano', 'Mountain', 'Wood', 'Magnifying glass tilted left'],
  biology: ['Dna', 'Microbe', 'Seedling', 'Herb', 'Potted plant', 'Four leaf clover', 'Leaf fluttering in wind', 'Deciduous tree', 'Evergreen tree', 'Cactus', 'Sunflower', 'Tulip', 'Hibiscus', 'Blossom', 'Mushroom', 'Butterfly', 'Bug', 'Lady beetle', 'Honeybee', 'Fish', 'Frog', 'Bird', 'Owl', 'Whale', 'Dolphin', 'Crab', 'Lizard', 'Spiral shell', 'Egg', 'Hatching chick', 'T-rex', 'Sauropod', 'Ear of corn'],
  anatomy: ['Anatomical heart', 'Lungs', 'Brain', 'Bone', 'Skull', 'Tooth', 'Eye', 'Ear', 'Nose', 'Mouth', 'Foot', 'Leg', 'Flexed biceps', 'Drop of blood', 'X-ray', 'Stethoscope', 'Syringe', 'Pill', 'Adhesive bandage', 'Health worker'],
  study: ['Books', 'Open book', 'Notebook', 'Memo', 'Spiral notepad', 'Clipboard', 'Card index dividers', 'Calendar', 'Alarm clock', 'Bookmark', 'Paperclip', 'Scissors', 'Crayon', 'Paintbrush', 'Artist palette', 'Graduation cap', 'Student', 'Teacher', 'Trophy', '1st place medal', 'Star', 'Glowing star', 'Sparkles', 'Party popper', 'Fire', 'Red heart', 'Thumbs up', 'Smiling face with sunglasses', 'Nerd face', 'Red exclamation mark', 'Check mark button']
}

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const RAW = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets'
const out = join(import.meta.dirname, '..', 'src', 'renderer', 'remote-public', 'store', 'stickers')

async function fetchOne(name) {
  const file = `${name.toLowerCase().replace(/ /g, '_')}_color.svg`
  for (const path of [`${name}/Color/${file}`, `${name}/Default/Color/${file.replace('_color.svg', '_color_default.svg')}`]) {
    const response = await fetch(`${RAW}/${path.split('/').map(encodeURIComponent).join('/')}`)
    if (response.ok) return await response.text()
  }
  throw new Error(`Not found: ${name}`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  for (const [pack, names] of Object.entries(FLUENT_PACKS)) {
    mkdirSync(join(out, pack), { recursive: true })
    for (const name of names) {
      const target = join(out, pack, `${slug(name)}.svg`)
      if (existsSync(target)) continue
      try {
        writeFileSync(target, await fetchOne(name))
        process.stdout.write('.')
      } catch (error) {
        console.error(`\n${pack}: ${error.message}`)
      }
    }
  }
  console.log('\ndone')
}
