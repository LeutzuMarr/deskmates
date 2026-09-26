import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, DesignExportFormat, VideoExportOptions } from '../shared/desktop-api'
import type { ProviderId } from '../shared/protocol'

const deskmates: DesktopApi = {
  getCoreConnection: () => ipcRenderer.invoke('core:connection'),

  onCoreRestarted: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('core:restarted', handler)
    return () => ipcRenderer.removeListener('core:restarted', handler)
  },

  secrets: {
    status: () => ipcRenderer.invoke('secrets:status'),
    set: (provider: ProviderId, key: string | null) => ipcRenderer.invoke('secrets:set', provider, key)
  },

  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),

  autoStart: {
    get: () => ipcRenderer.invoke('app:autoStart:get'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:autoStart:set', enabled)
  },

  appearance: {
    pickImage: () => ipcRenderer.invoke('appearance:pickImage'),
    pickFont: () => ipcRenderer.invoke('appearance:pickFont'),
    pickAnimation: () => ipcRenderer.invoke('appearance:pickAnimation'),
    setWindowIcon: (dataUrl: string | null) => ipcRenderer.invoke('appearance:setWindowIcon', dataUrl)
  },

  design: {
    export: (projectId: string, format: DesignExportFormat, width?: number, file?: string) =>
      ipcRenderer.invoke('design:export', projectId, format, width, file),
    exportVideo: (projectId: string, file: string, options: VideoExportOptions) =>
      ipcRenderer.invoke('design:exportVideo', projectId, file, options),
    cancelVideo: () => ipcRenderer.invoke('design:cancelVideo'),
    onVideoProgress: (listener: (fraction: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, fraction: number): void => listener(fraction)
      ipcRenderer.on('design:videoProgress', handler)
      return () => {
        ipcRenderer.removeListener('design:videoProgress', handler)
      }
    },
    systemFonts: () => ipcRenderer.invoke('design:systemFonts')
  },

  engine: {
    installWsl: () => ipcRenderer.invoke('engine:installWsl')
  }
}

contextBridge.exposeInMainWorld('deskmates', deskmates)
