// Messages exchanged with window.postMessage between the design preview (the editor script running
// inside the sandboxed preview iframe) and the app's Design tab.

export const EDITOR_SOURCE = 'deskmates-editor'
export const APP_SOURCE = 'deskmates-app'

/** URL scheme served by the Electron main process for design previews and the editor script. */
export const PREVIEW_SCHEME = 'deskmates-preview'
export const previewUrl = (projectId: string, file = 'index.html'): string =>
  `${PREVIEW_SCHEME}://design/${projectId}/${file}`
export const EDITOR_SCRIPT_URL = `${PREVIEW_SCHEME}://editor/editor.js`
/** The Design Component runtime every `.dc.html` file loads. */
export const DC_RUNTIME_URL = `${PREVIEW_SCHEME}://editor/dc-support.js`
/** A design-relative path (forward slashes) encoded for previewUrl. */
export const encodePreviewPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')
/** Whether a design-relative path is a Design Component, rendered by the DC runtime instead of edited in place. */
export const isDesignComponent = (path: string): boolean => /\.dc\.html?$/i.test(path)

/** Attribute the editor puts on every element so the app and the AI can refer to it. */
export const ID_ATTR = 'data-dm-id'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementStyle {
  /**
   * In `select` messages: the first family of the computed font-family, without quotes.
   * In `setStyle`: a complete CSS font-family value, for example `"Playfair Display", serif`.
   */
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: string
  textAlign: string
  lineHeight: string
  letterSpacing: string
  backgroundColor: string
  borderRadius: string
  opacity: number
  width: number
  height: number
  translateX: number
  translateY: number
}

export type ChangeReason =
  | 'move'
  | 'resize'
  | 'text'
  | 'style'
  | 'delete'
  | 'duplicate'
  | 'reorder'
  | 'undo'
  | 'redo'

export type EditorToApp =
  | { source: typeof EDITOR_SOURCE; type: 'ready' }
  | { source: typeof EDITOR_SOURCE; type: 'hover'; id: string | null; label: string; rect: Rect | null }
  | {
      source: typeof EDITOR_SOURCE
      type: 'select'
      id: string
      tag: string
      label: string
      text: string | null
      editableText: boolean
      style: ElementStyle
      rect: Rect
      /** The element's outerHTML without editor artifacts, cut at 2 000 characters. */
      html: string
    }
  | { source: typeof EDITOR_SOURCE; type: 'deselect' }
  | { source: typeof EDITOR_SOURCE; type: 'change'; html: string; reason: ChangeReason }

export type EditorCommand = 'undo' | 'redo' | 'delete' | 'duplicate' | 'deselect' | 'bringForward' | 'sendBackward'

/** Only stylesheet links under this URL may be added to a design by `loadFont`. */
export const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2'

export interface WebFont {
  family: string
  fallback: 'sans-serif' | 'serif' | 'monospace'
  /** Google Fonts CSS2 axis spec, or null when only the regular weight exists. */
  weights: string | null
}

/** Web fonts offered in the Design tab's font picker, next to the fonts installed on the PC. */
export const WEB_FONTS: readonly WebFont[] = [
  { family: 'Inter', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Roboto', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Open Sans', fallback: 'sans-serif', weights: 'wght@300..800' },
  { family: 'Lato', fallback: 'sans-serif', weights: 'wght@100;300;400;700;900' },
  { family: 'Montserrat', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Poppins', fallback: 'sans-serif', weights: 'wght@100;200;300;400;500;600;700;800;900' },
  { family: 'DM Sans', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Space Grotesk', fallback: 'sans-serif', weights: 'wght@300..700' },
  { family: 'Work Sans', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Nunito', fallback: 'sans-serif', weights: 'wght@200..900' },
  { family: 'Raleway', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Rubik', fallback: 'sans-serif', weights: 'wght@300..900' },
  { family: 'Manrope', fallback: 'sans-serif', weights: 'wght@200..800' },
  { family: 'Outfit', fallback: 'sans-serif', weights: 'wght@100..900' },
  { family: 'Plus Jakarta Sans', fallback: 'sans-serif', weights: 'wght@200..800' },
  { family: 'Figtree', fallback: 'sans-serif', weights: 'wght@300..900' },
  { family: 'Sora', fallback: 'sans-serif', weights: 'wght@100..800' },
  { family: 'Bricolage Grotesque', fallback: 'sans-serif', weights: 'wght@200..800' },
  { family: 'IBM Plex Sans', fallback: 'sans-serif', weights: 'wght@100;200;300;400;500;600;700' },
  { family: 'Playfair Display', fallback: 'serif', weights: 'wght@400..900' },
  { family: 'Merriweather', fallback: 'serif', weights: 'wght@300;400;700;900' },
  { family: 'Source Serif 4', fallback: 'serif', weights: 'wght@200..900' },
  { family: 'Fraunces', fallback: 'serif', weights: 'wght@100..900' },
  { family: 'EB Garamond', fallback: 'serif', weights: 'wght@400..800' },
  { family: 'Cormorant Garamond', fallback: 'serif', weights: 'wght@300;400;500;600;700' },
  { family: 'Libre Baskerville', fallback: 'serif', weights: 'wght@400;700' },
  { family: 'DM Serif Display', fallback: 'serif', weights: null },
  { family: 'Instrument Serif', fallback: 'serif', weights: null },
  { family: 'JetBrains Mono', fallback: 'monospace', weights: 'wght@100..800' },
  { family: 'IBM Plex Mono', fallback: 'monospace', weights: 'wght@100;200;300;400;500;600;700' }
]

export const webFontHref = (font: WebFont): string =>
  `${GOOGLE_FONTS_CSS}?family=${font.family.replace(/ /g, '+')}${font.weights ? `:${font.weights}` : ''}&display=swap`

export const webFontCss = (font: WebFont): string => `"${font.family}", ${font.fallback}`

export type AppToEditor =
  | { source: typeof APP_SOURCE; type: 'setStyle'; id: string; style: Partial<ElementStyle> }
  | { source: typeof APP_SOURCE; type: 'setText'; id: string; text: string }
  | { source: typeof APP_SOURCE; type: 'command'; name: EditorCommand }
  | { source: typeof APP_SOURCE; type: 'setEditing'; editing: boolean }
  | { source: typeof APP_SOURCE; type: 'loadFont'; family: string; href: string }
