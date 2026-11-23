/** The tools and their settings, kept between visits. */
import type { PenTool } from '../model'

export type InkTool = PenTool
export type ActiveTool = InkTool | 'eraser' | 'lasso' | 'shape' | 'text' | 'tape' | 'sticky' | 'eyedropper' | 'fill' | 'hand'

export interface PenSettings {
  color: string
  width: number
  opacity?: number
}

export interface Favorite extends PenSettings {
  tool: InkTool
}

export interface ToolState {
  tool: ActiveTool
  /** The ink tool last used, so the eraser can hand back to it. */
  lastInk: InkTool
  pens: Record<InkTool, PenSettings>
  eraser: { mode: 'stroke' | 'precise'; size: number }
  favorites: Favorite[]
  recentColors: string[]
  /** Draw with a finger too (otherwise fingers move the page). */
  fingerDraws: boolean
  /** Keep the page upright; when off, two fingers can turn it. */
  rotationLocked: boolean
  /** Hold the pen still at the end of a line to straighten it into a shape. */
  holdToShape: boolean
  /** How the line answers to pressure: < 1 heavier, > 1 lighter. */
  pressureCurve: number
  /** How much speed thins the line, for pens without pressure. */
  speedEffect: number
  /** How much tilting the pen widens the pencil and brushes. */
  tiltEffect: number
  /** Stabiliser, 0 (off) … 0.9 (very steady). */
  stabilizer: number
  /** The advanced (Fresco-style) drawing tools are shown. */
  advanced: boolean
  /** Text style for new text boxes. */
  text: { size: number; color: string; font: 'sans' | 'serif' | 'mono' | 'hand' }
}

export const INK_TOOLS: InkTool[] = ['pen', 'pencil', 'highlighter', 'marker', 'graphite', 'charcoal', 'airbrush', 'watercolor']

export function isInk(tool: ActiveTool): tool is InkTool {
  return (INK_TOOLS as string[]).includes(tool)
}

export const PALETTE = [
  '#1c1c1e',
  '#5b5b60',
  '#1f4fd1',
  '#2f80ed',
  '#0f9d76',
  '#4caf50',
  '#f2b705',
  '#f2711c',
  '#e03131',
  '#d6336c',
  '#8e44ad',
  '#7a4a2a'
]

export const HIGHLIGHTS = ['#ffe55c', '#9cf27a', '#7ad8ff', '#ff9ccf', '#ffb35c', '#c59cff']

export const DEFAULT_TOOLS: ToolState = {
  tool: 'pen',
  lastInk: 'pen',
  pens: {
    pen: { color: '#1c1c1e', width: 2.6 },
    pencil: { color: '#3a3a3c', width: 2.4, opacity: 0.9 },
    highlighter: { color: '#ffe55c', width: 18, opacity: 0.4 },
    marker: { color: '#1f4fd1', width: 7, opacity: 0.85 },
    graphite: { color: '#2b2b2d', width: 6 },
    charcoal: { color: '#1c1c1e', width: 16 },
    airbrush: { color: '#2f80ed', width: 40 },
    watercolor: { color: '#2f80ed', width: 22, opacity: 0.7 }
  },
  eraser: { mode: 'stroke', size: 14 },
  favorites: [
    { tool: 'pen', color: '#1c1c1e', width: 2.6 },
    { tool: 'pen', color: '#1f4fd1', width: 2.6 },
    { tool: 'pen', color: '#e03131', width: 2.6 },
    { tool: 'highlighter', color: '#ffe55c', width: 18, opacity: 0.4 }
  ],
  recentColors: [],
  fingerDraws: false,
  rotationLocked: true,
  holdToShape: true,
  pressureCurve: 1,
  speedEffect: 0.6,
  tiltEffect: 0.8,
  stabilizer: 0.15,
  advanced: false,
  text: { size: 20, color: '#1c1c1e', font: 'sans' }
}

/** Width presets per tool: thin, medium, thick. */
export const WIDTHS: Record<InkTool, [number, number, number]> = {
  pen: [1.6, 2.6, 4.2],
  pencil: [1.6, 2.4, 4],
  highlighter: [12, 18, 28],
  marker: [4, 7, 12],
  graphite: [3, 6, 12],
  charcoal: [8, 16, 30],
  airbrush: [20, 40, 80],
  watercolor: [10, 22, 44]
}

/** Fills in settings added after the saved state was stored. */
export function withDefaults(saved: Partial<ToolState> | null): ToolState {
  if (!saved) return structuredClone(DEFAULT_TOOLS)
  return {
    ...structuredClone(DEFAULT_TOOLS),
    ...saved,
    pens: { ...structuredClone(DEFAULT_TOOLS.pens), ...(saved.pens ?? {}) },
    eraser: { ...DEFAULT_TOOLS.eraser, ...(saved.eraser ?? {}) },
    text: { ...DEFAULT_TOOLS.text, ...(saved.text ?? {}) }
  }
}
