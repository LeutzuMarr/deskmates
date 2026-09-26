import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ChevronDown, Component, Download, FileCode, FileImage, FileText, FileVideo, Pencil, RefreshCw, Redo2, Undo2 } from 'lucide-react'
import { EDITOR_SOURCE, encodePreviewPath, isDesignComponent, previewUrl } from '../../../shared/design-bridge'
import type { EditorToApp } from '../../../shared/design-bridge'
import { DEVICE_WIDTHS } from '../../../shared/protocol'
import type { DesignFile, DeviceSize } from '../../../shared/protocol'
import type { DesignExportFormat, VideoExportOptions } from '../../../shared/desktop-api'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { useDismissableMenu } from '../lib/useMenu'
import {
  DEVICE_LABELS,
  DEVICE_ORDER,
  ZOOM_OPTIONS,
  concentricVars,
  debounce,
  defaultDesignFile,
  postToIframe
} from '../lib/design'
import type { OutgoingEditorMessage, Selection, Zoom } from '../lib/design'
import { PropertiesPanel } from './PropertiesPanel'
import { VideoExportDialog } from './VideoExportDialog'
import { WorkingPill } from './Working'

interface PreviewPaneProps {
  projectId: string
  running: boolean
  /** When the running turn's prompt was sent, for the popup's timer. */
  workingSince?: number | null
  selection: Selection | null
  onSelectionChange: (selection: Selection | null) => void
  onClearSelection: () => void
  onAskAboutThis: () => void
  iframeRef: RefObject<HTMLIFrameElement | null>
}

type SaveState = 'idle' | 'saving' | 'saved'

export function PreviewPane({
  projectId,
  running,
  workingSince,
  selection,
  onSelectionChange,
  onClearSelection,
  onAskAboutThis,
  iframeRef
}: PreviewPaneProps) {
  const showToast = useStore((s) => s.showToast)
  const chosenFile = useStore((s) => s.designFiles[projectId])
  const setDesignFile = useStore((s) => s.setDesignFile)

  const [device, setDevice] = useState<DeviceSize>('desktop')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [videoFormat, setVideoFormat] = useState<VideoExportOptions['format'] | null>(null)
  const [editing, setEditing] = useState(true)
  const [ready, setReady] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Selection | null>(null)
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const [files, setFiles] = useState<DesignFile[] | null>(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)

  const frameRef = useRef<HTMLDivElement>(null)
  const zoomMenuRef = useDismissableMenu<HTMLDivElement>(zoomMenuOpen, () => setZoomMenuOpen(false))
  const exportMenuRef = useDismissableMenu<HTMLDivElement>(exportMenuOpen, () => setExportMenuOpen(false))
  const fileMenuRef = useDismissableMenu<HTMLDivElement>(fileMenuOpen, () => setFileMenuOpen(false))

  const file = chosenFile ?? (files ? defaultDesignFile(files) : null)
  // Design Components render from their template; the editor would save the rendered DOM over it.
  const isDc = file !== null && isDesignComponent(file)
  const fileRef = useRef(file)
  fileRef.current = file

  const deviceWidth = DEVICE_WIDTHS[device]
  const editingEffective = editing && !running && !isDc

  const bumpReload = (): void => setReloadToken((t) => t + 1)

  // Persists across reloads within this design (the pane is remounted per-design by DesignView's key).
  const saveRef = useRef(
    debounce((html: string, reason: string, path: string) => {
      if (isDesignComponent(path)) return
      setSaveState('saving')
      void core.call('designs.save', { projectId, html, reason, path }).then(
        () => setSaveState('saved'),
        (error: unknown) => {
          showToast(`Couldn't save the design: ${error instanceof Error ? error.message : String(error)}`)
          bumpReload()
        }
      )
    }, 400)
  )

  // Measure the frame card so "Fit" and the scaled iframe size can be computed.
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    // ResizeObserver only reports on a rendered frame, which a hidden or occluded window may not
    // produce for a while; measure once up front so the preview never waits on it.
    const rect = el.getBoundingClientRect()
    if (rect.width > 0) setFrameSize({ width: rect.width, height: rect.height })
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setFrameSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A fresh iframe means a fresh handshake; keep device/zoom, drop the rest per Part C2.
  useEffect(() => {
    setReady(false)
    setHoverLabel(null)
    setPinned(null)
    onSelectionChange(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, file])

  const loadFiles = useRef(() => {
    void core.call('designs.files', { projectId }).then(setFiles, (error: unknown) => {
      console.error('[preview] could not list the design files', error)
      setFiles((current) => current ?? [])
    })
  })

  useEffect(() => {
    loadFiles.current()
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      const raw: unknown = event.data
      if (!raw || typeof raw !== 'object' || (raw as { source?: unknown }).source !== EDITOR_SOURCE) return
      const msg = raw as EditorToApp
      switch (msg.type) {
        case 'ready':
          setReady(true)
          break
        case 'hover':
          setHoverLabel(msg.label || null)
          break
        case 'select':
          setPinned(msg)
          onSelectionChange(msg)
          break
        case 'deselect':
          onSelectionChange(null)
          break
        case 'change':
          if (fileRef.current && !isDesignComponent(fileRef.current)) saveRef.current(msg.html, msg.reason, fileRef.current)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [iframeRef, onSelectionChange])

  useEffect(() => {
    if (ready) postToIframe(iframeRef.current, { type: 'setEditing', editing: editingEffective })
  }, [ready, editingEffective, iframeRef])

  useEffect(() => {
    return core.onEvent((event) => {
      if (event.type === 'design.updated' && event.projectId === projectId && event.source !== 'editor') {
        bumpReload()
        loadFiles.current()
      } else if (event.type === 'design.show' && event.projectId === projectId) {
        bumpReload()
        loadFiles.current()
      }
    })
  }, [projectId])

  const prevRunningRef = useRef(running)
  useEffect(() => {
    if (prevRunningRef.current && !running) {
      bumpReload()
      loadFiles.current()
    }
    prevRunningRef.current = running
  }, [running])

  const effectiveZoom =
    zoom === 'fit' ? (frameSize.width > 0 ? Math.min(1, frameSize.width / deviceWidth) : 1) : zoom
  const iframeHeight = frameSize.height > 0 && effectiveZoom > 0 ? frameSize.height / effectiveZoom : frameSize.height

  const post = (msg: OutgoingEditorMessage): void => postToIframe(iframeRef.current, msg)

  const runExport = async (format: DesignExportFormat): Promise<void> => {
    setExportMenuOpen(false)
    try {
      const path = await window.deskmates.design.export(projectId, format, deviceWidth, file ?? undefined)
      if (path === null) return
      const fileName = path.split(/[\\/]/).pop() ?? path
      showToast(`Saved ${fileName}`, { label: 'Open', onClick: () => void window.deskmates.openPath(path) })
    } catch (error) {
      showToast(`Couldn't export the design: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-canvas px-4 pt-3">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        {files && files.length > 0 && file && (
          <div className="relative">
            <button
              type="button"
              className="btn btn-outline max-w-[220px]"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              aria-label={`Page shown: ${file}`}
              title={file}
              onClick={() => setFileMenuOpen((v) => !v)}
            >
              {isDc ? (
                <Component size={14} aria-hidden="true" className="mr-1.5 shrink-0" />
              ) : (
                <FileCode size={14} aria-hidden="true" className="mr-1.5 shrink-0" />
              )}
              <span className="truncate">{file}</span>
              <ChevronDown size={13} aria-hidden="true" className="ml-1 shrink-0" />
            </button>
            {fileMenuOpen && (
              <div
                ref={fileMenuRef}
                role="menu"
                aria-label="Pages"
                className="menu"
                style={{ top: '100%', left: 0, marginTop: 4, maxHeight: 360, overflowY: 'auto' }}
              >
                {files.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    role="menuitemradio"
                    className="menu-item"
                    aria-checked={entry.path === file}
                    onClick={() => {
                      setFileMenuOpen(false)
                      setDesignFile(projectId, entry.path)
                    }}
                  >
                    {entry.kind === 'dc' ? <Component size={14} aria-hidden="true" /> : <FileCode size={14} aria-hidden="true" />}
                    <span className="truncate">{entry.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="segmented" role="radiogroup" aria-label="Device">
          {DEVICE_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              className="segmented-item"
              role="radio"
              aria-checked={device === d}
              onClick={() => setDevice(d)}
            >
              {DEVICE_LABELS[d]}
            </button>
          ))}
        </div>

        <div className="relative">
          <button
            type="button"
            className="btn btn-outline"
            aria-haspopup="menu"
            aria-expanded={zoomMenuOpen}
            onClick={() => setZoomMenuOpen((v) => !v)}
          >
            {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
            <ChevronDown size={13} aria-hidden="true" className="ml-1" />
          </button>
          {zoomMenuOpen && (
            <div ref={zoomMenuRef} role="menu" aria-label="Zoom" className="menu" style={{ top: '100%', left: 0, marginTop: 4 }}>
              {ZOOM_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  role="menuitemradio"
                  className="menu-item"
                  aria-checked={zoom === opt.value}
                  onClick={() => {
                    setZoom(opt.value)
                    setZoomMenuOpen(false)
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="btn-icon" aria-label="Undo" disabled={isDc} onClick={() => post({ type: 'command', name: 'undo' })}>
          <Undo2 size={15} aria-hidden="true" />
        </button>
        <button type="button" className="btn-icon" aria-label="Redo" disabled={isDc} onClick={() => post({ type: 'command', name: 'redo' })}>
          <Redo2 size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label="Toggle direct editing"
          aria-pressed={editingEffective}
          disabled={running || isDc}
          title={isDc ? 'Design components are edited by asking the assistant' : undefined}
          onClick={() => setEditing((v) => !v)}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button type="button" className="btn-icon" aria-label="Reload preview" onClick={bumpReload}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>

        <div className="relative ml-auto">
          <button
            type="button"
            className="btn btn-outline"
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            onClick={() => setExportMenuOpen((v) => !v)}
          >
            <Download size={14} aria-hidden="true" className="mr-1.5" />
            Export
          </button>
          {exportMenuOpen && (
            <div ref={exportMenuRef} role="menu" aria-label="Export" className="menu" style={{ top: '100%', right: 0, marginTop: 4 }}>
              <button type="button" role="menuitem" className="menu-item" onClick={() => void runExport('html')}>
                <FileCode size={14} aria-hidden="true" />
                HTML file
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => void runExport('pdf')}>
                <FileText size={14} aria-hidden="true" />
                PDF
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => void runExport('png')}>
                <FileImage size={14} aria-hidden="true" />
                PNG image
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!file}
                onClick={() => {
                  setExportMenuOpen(false)
                  setVideoFormat('mp4')
                }}
              >
                <FileVideo size={14} aria-hidden="true" />
                Video (MP4, WebM)
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!file}
                onClick={() => {
                  setExportMenuOpen(false)
                  setVideoFormat('gif')
                }}
              >
                <FileVideo size={14} aria-hidden="true" />
                GIF animation
              </button>
            </div>
          )}
          {file && (
            <VideoExportDialog
              open={videoFormat !== null}
              onClose={() => setVideoFormat(null)}
              projectId={projectId}
              file={file}
              format={videoFormat ?? 'mp4'}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
      <div
        ref={frameRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-3xl border border-rule bg-card"
      >
        {frameSize.width > 0 && file && (
          <iframe
            ref={iframeRef}
            title="Design preview"
            sandbox="allow-scripts"
            src={`${previewUrl(projectId, encodePreviewPath(file))}?v=${reloadToken}`}
            className="r-concentric shrink-0 border-0 bg-white"
            style={{
              width: deviceWidth,
              height: iframeHeight,
              transform: `scale(${effectiveZoom})`,
              transformOrigin: 'center center',
              ...concentricVars(1)
            }}
          />
        )}
        {running && <WorkingPill since={workingSince} />}
      </div>
        {pinned && !running && !isDc && (
          <PropertiesPanel
            selection={pinned}
            onPost={post}
            onClose={() => {
              setPinned(null)
              onClearSelection()
            }}
            onAskAboutThis={onAskAboutThis}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5 py-2 text-[12px] text-ink-faint">
        {isDc && <span className="truncate">Design component · edit it by asking the assistant ·</span>}
        {hoverLabel && <span className="truncate">{hoverLabel} ·</span>}
        <span>{deviceWidth}px</span>
        <span>·</span>
        <span>{zoom === 'fit' ? `Fit (${Math.round(effectiveZoom * 100)}%)` : `${Math.round(effectiveZoom * 100)}%`}</span>
        {saveState !== 'idle' && (
          <>
            <span>·</span>
            <span className={saveState === 'saving' ? 'pulse-txt' : ''}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
          </>
        )}
      </div>
    </div>
  )
}
