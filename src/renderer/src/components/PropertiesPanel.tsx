import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  BringToFront,
  Copy,
  MessageCircle,
  SendToBack,
  Trash2,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { webFontCss, webFontHref } from '../../../shared/design-bridge'
import type { WebFont } from '../../../shared/design-bridge'
import { clamp, concentricVars, isValidCssScalar, isValidHex } from '../lib/design'
import type { OutgoingEditorMessage, Selection } from '../lib/design'
import { FontCombobox } from './FontCombobox'

interface PropertiesPanelProps {
  selection: Selection
  onPost: (msg: OutgoingEditorMessage) => void
  onClose: () => void
  onAskAboutThis: () => void
}

export function PropertiesPanel({ selection, onPost, onClose, onAskAboutThis }: PropertiesPanelProps) {
  const { id, style } = selection
  const setStyle = useCallback(
    (patch: Partial<Selection['style']>) => onPost({ type: 'setStyle', id, style: patch }),
    [onPost, id]
  )

  const showText = selection.editableText || Boolean(selection.text)

  return (
    <div className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-3xl border border-rule bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule p-4">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{selection.label}</span>
        <button
          type="button"
          aria-label="Close properties panel"
          className="btn-icon r-concentric shrink-0"
          style={concentricVars(16)}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="scroll-area flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-6">
          {showText && (
            <Section title="Text">
              <div className="field">
                <span className="field-label">Font</span>
                <FontCombobox
                  value={style.fontFamily}
                  onPickWebFont={(font: WebFont) => {
                    onPost({ type: 'loadFont', family: font.family, href: webFontHref(font) })
                    setStyle({ fontFamily: webFontCss(font) })
                  }}
                  onPickSystemFont={(name) => setStyle({ fontFamily: `"${name}", sans-serif` })}
                />
              </div>

              <SliderNumberField
                label="Size"
                value={style.fontSize}
                min={8}
                max={200}
                suffix="px"
                onCommit={(v) => setStyle({ fontSize: v })}
              />

              <label className="field">
                <span className="field-label">Weight</span>
                <select
                  className="select"
                  value={String(style.fontWeight)}
                  onChange={(event) => setStyle({ fontWeight: Number(event.target.value) })}
                >
                  {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>

              <ColorField label="Color" value={style.color} onCommit={(hex) => setStyle({ color: hex })} />

              <div className="field">
                <span className="field-label">Align</span>
                <div className="segmented" role="radiogroup" aria-label="Align">
                  {(
                    [
                      ['left', AlignLeft, 'Align left'],
                      ['center', AlignCenter, 'Align center'],
                      ['right', AlignRight, 'Align right'],
                      ['justify', AlignJustify, 'Justify']
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-label={label}
                      aria-checked={style.textAlign === value}
                      className="segmented-item"
                      onClick={() => setStyle({ textAlign: value })}
                    >
                      <Icon size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <ValidatedTextField
                  label="Line height"
                  value={style.lineHeight}
                  validate={isValidCssScalar}
                  onCommit={(v) => setStyle({ lineHeight: v })}
                />
                <ValidatedTextField
                  label="Letter spacing"
                  value={style.letterSpacing}
                  validate={isValidCssScalar}
                  onCommit={(v) => setStyle({ letterSpacing: v })}
                />
              </div>

              {selection.editableText && (
                <TextBody id={selection.id} initialText={selection.text ?? ''} onPost={onPost} />
              )}
            </Section>
          )}

          <Section title="Layout">
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="X" value={style.translateX} onCommit={(v) => setStyle({ translateX: v })} />
              <NumberField label="Y" value={style.translateY} onCommit={(v) => setStyle({ translateY: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="W"
                value={style.width}
                onCommit={(v) => setStyle({ width: v })}
                onAuto={() => setStyle({ width: 0 })}
              />
              <NumberField
                label="H"
                value={style.height}
                onCommit={(v) => setStyle({ height: v })}
                onAuto={() => setStyle({ height: 0 })}
              />
            </div>
          </Section>

          <Section title="Fill and shape">
            <ColorField
              label="Background"
              value={style.backgroundColor}
              onCommit={(hex) => setStyle({ backgroundColor: hex })}
              onNone={() => setStyle({ backgroundColor: 'transparent' })}
            />
            <NumberField
              label="Corner radius"
              value={parsePx(style.borderRadius)}
              min={0}
              onCommit={(v) => setStyle({ borderRadius: `${v}px` })}
            />
            <SliderNumberField
              label="Opacity"
              value={Math.round(style.opacity * 100)}
              min={0}
              max={100}
              suffix="%"
              onCommit={(v) => setStyle({ opacity: v / 100 })}
            />
          </Section>

          <Section title="Arrange">
            <div className="grid grid-cols-2 gap-2">
              <ArrangeButton icon={Copy} label="Duplicate" onClick={() => onPost({ type: 'command', name: 'duplicate' })} />
              <ArrangeButton icon={Trash2} label="Delete" onClick={() => onPost({ type: 'command', name: 'delete' })} />
              <ArrangeButton
                icon={BringToFront}
                label="Bring forward"
                onClick={() => onPost({ type: 'command', name: 'bringForward' })}
              />
              <ArrangeButton
                icon={SendToBack}
                label="Send backward"
                onClick={() => onPost({ type: 'command', name: 'sendBackward' })}
              />
            </div>
          </Section>

          <Section title="Ask">
            <button
              type="button"
              className="btn btn-outline r-concentric w-full"
              style={concentricVars(16)}
              onClick={onAskAboutThis}
            >
              <MessageCircle size={14} aria-hidden="true" className="mr-1.5" />
              Ask about this
            </button>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="caption">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function ArrangeButton({
  icon: Icon,
  label,
  onClick
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" className="btn btn-outline justify-start" onClick={onClick}>
      <Icon size={14} aria-hidden="true" className="mr-1.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function parsePx(value: string): number {
  const match = /^-?\d+(\.\d+)?/.exec(value.trim())
  return match ? Number(match[0]) : 0
}

function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  onAuto
}: {
  label: string
  value: number
  min?: number
  max?: number
  onCommit: (value: number) => void
  onAuto?: () => void
}) {
  const [text, setText] = useState(String(value))
  const id = useId()
  useEffect(() => setText(String(value)), [value])

  const commit = (): void => {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && text.trim() !== '') {
      const clamped = clamp(parsed, min, max)
      setText(String(clamped))
      onCommit(clamped)
    } else {
      setText(String(value))
    }
  }

  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          className="input"
          type="number"
          value={text}
          min={min}
          max={max}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
        {onAuto && (
          <button type="button" className="btn btn-text shrink-0 px-2 text-[12px]" onClick={onAuto}>
            Auto
          </button>
        )}
      </div>
    </label>
  )
}

/** A number field paired with a slider on the same 0-100/8-200-style range; the slider posts at most once per frame. */
function SliderNumberField({
  label,
  value,
  min,
  max,
  suffix,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onCommit: (value: number) => void
}) {
  const id = useId()
  const throttled = useRafThrottledCallback(onCommit)

  return (
    <div className="field">
      <span className="field-label">
        {label} · {value}
        {suffix}
      </span>
      <div className="flex items-center gap-2">
        <input
          id={id}
          aria-label={label}
          type="range"
          min={min}
          max={max}
          value={clamp(value, min, max)}
          onChange={(event) => throttled(Number(event.target.value))}
          className="w-full"
        />
        <input
          aria-label={label}
          className="input w-16 shrink-0"
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            if (Number.isFinite(parsed)) onCommit(clamp(parsed, min, max))
          }}
        />
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  onCommit,
  onNone
}: {
  label: string
  value: string
  onCommit: (hex: string) => void
  onNone?: () => void
}) {
  const [text, setText] = useState(value)
  const id = useId()
  useEffect(() => setText(value), [value])

  const commit = (): void => {
    if (isValidHex(text)) onCommit(text.trim())
    else setText(value)
  }

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={isValidHex(value) ? value : '#000000'}
          onChange={(event) => {
            setText(event.target.value)
            onCommit(event.target.value)
          }}
          className="h-8 w-8 shrink-0 cursor-pointer border border-rule bg-transparent p-0"
        />
        <input
          id={id}
          aria-label={`${label} hex value`}
          className="input min-w-0 flex-1"
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
        {onNone && (
          <button type="button" className="btn btn-text shrink-0 px-2 text-[12px]" onClick={onNone}>
            None
          </button>
        )}
      </div>
    </div>
  )
}

function ValidatedTextField({
  label,
  value,
  validate,
  onCommit
}: {
  label: string
  value: string
  validate: (value: string) => boolean
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState(value)
  const id = useId()
  useEffect(() => setText(value), [value])

  const commit = (): void => {
    const trimmed = text.trim()
    if (validate(trimmed)) onCommit(trimmed)
    else setText(value)
  }

  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input
        id={id}
        className="input"
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
    </label>
  )
}

function TextBody({
  id,
  initialText,
  onPost
}: {
  id: string
  initialText: string
  onPost: (msg: OutgoingEditorMessage) => void
}) {
  const [text, setText] = useState(initialText)
  const fieldId = useId()
  useEffect(() => setText(initialText), [id, initialText])

  const commit = (): void => onPost({ type: 'setText', id, text })

  return (
    <label className="field" htmlFor={fieldId}>
      <span className="field-label">Text</span>
      <textarea
        id={fieldId}
        className="textarea min-h-[72px]"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

/** Runs the latest `fn` at most once per animation frame; the returned callback's identity never changes. */
function useRafThrottledCallback<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const scheduledRef = useRef(false)
  const argsRef = useRef<A | null>(null)

  return useCallback((...args: A) => {
    argsRef.current = args
    if (scheduledRef.current) return
    scheduledRef.current = true
    requestAnimationFrame(() => {
      scheduledRef.current = false
      const toRun = argsRef.current
      argsRef.current = null
      if (toRun) fnRef.current(...toRun)
    })
  }, [])
}
