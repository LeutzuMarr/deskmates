import type { FontChoice, Settings } from '../../../shared/protocol'

const UI_FAMILY = 'Deskmates UI Custom'
const REPLY_FAMILY = 'Deskmates Reply Custom'
const FONT_STYLE_ID = 'custom-fonts'

const fallbackStacks = {
  ui: `'Inter Variable', system-ui, -apple-system, sans-serif`,
  reply: `'Source Serif 4 Variable', Georgia, 'Times New Roman', serif`
} as const

function fontFaceRule(family: string, choice: FontChoice): string {
  return `@font-face { font-family: '${family}'; src: url('${choice.dataUrl}'); font-display: swap; }`
}

const ICON_MIME_RE = /^data:([a-z0-9.+-]+);/i

/** Electron's nativeImage only decodes PNG and JPEG from a data URL; everything else gets rasterized. */
async function windowIconFromLogo(logo: string | null): Promise<string | null> {
  if (!logo) return null
  const mime = ICON_MIME_RE.exec(logo)?.[1]?.toLowerCase() ?? ''
  if (mime === 'image/png' || mime === 'image/jpeg') return logo
  const img = new Image()
  img.src = logo
  try {
    await img.decode()
  } catch {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  canvas.getContext('2d')?.drawImage(img, 0, 0, 256, 256)
  return canvas.toDataURL('image/png')
}

/** Apply the chosen fonts, logo and window icon whenever settings load or change. */
export function applyAppearance(settings: Settings | null): void {
  if (!settings) return
  const appearance = settings.appearance
  if (!appearance) return

  let styleEl = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = FONT_STYLE_ID
    document.head.appendChild(styleEl)
  }

  const uiStack = appearance.uiFont ? `'${UI_FAMILY}', ${fallbackStacks.ui}` : fallbackStacks.ui
  const replyStack = appearance.replyFont ? `'${REPLY_FAMILY}', ${fallbackStacks.reply}` : fallbackStacks.reply

  let css = ''
  if (appearance.uiFont) css += fontFaceRule(UI_FAMILY, appearance.uiFont)
  if (appearance.replyFont) css += fontFaceRule(REPLY_FAMILY, appearance.replyFont)
  css += `:root {
  --font-sans: ${uiStack};
  --font-serif: ${replyStack};
  --font-ui: ${uiStack};
  --font-reply: ${replyStack};
}`
  styleEl.textContent = css

  void windowIconFromLogo(appearance.logo)
    .then((icon) => window.deskmates.appearance.setWindowIcon(icon))
    .catch(() => undefined)
}

const registeredFontFaces = new Set<string>()

/** Register fonts embedded in a .lottie file before the animation can render text. */
export async function registerAnimationFonts(fonts: FontChoice[]): Promise<void> {
  for (const font of fonts) {
    if (registeredFontFaces.has(font.dataUrl)) continue
    try {
      const face = new FontFace(font.name, `url(${font.dataUrl})`)
      await face.load()
      document.fonts.add(face)
      registeredFontFaces.add(font.dataUrl)
    } catch {
      // A font that fails to load shouldn't block the animation.
    }
  }
}