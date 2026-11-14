import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopApi, DesignExportFormat, HostPlatform, ThemeChoice, VideoExportOptions } from '../shared/desktop-api'
import type { ProviderId } from '../shared/protocol'

function hostPlatform(): HostPlatform {
  const { platform } = process
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other'
}

const deskmates: DesktopApi = {
  platform: hostPlatform(),

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizeChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized)
      ipcRenderer.on('window:maximizeChange', handler)
      return () => {
        ipcRenderer.removeListener('window:maximizeChange', handler)
      }
    }
  },

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
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),

  autoStart: {
    get: () => ipcRenderer.invoke('app:autoStart:get'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:autoStart:set', enabled)
  },

  appearance: {
    pickImage: () => ipcRenderer.invoke('appearance:pickImage'),
    pickFont: () => ipcRenderer.invoke('appearance:pickFont'),
    pickAnimation: () => ipcRenderer.invoke('appearance:pickAnimation'),
    setWindowIcon: (dataUrl: string | null) => ipcRenderer.invoke('appearance:setWindowIcon', dataUrl),
    setTheme: (theme: ThemeChoice) => ipcRenderer.invoke('appearance:setTheme', theme)
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

  browser: {
    setBounds: (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
    navigate: (op, url) => ipcRenderer.invoke('browser:navigate', op, url),
    selectTab: (tabId) => ipcRenderer.invoke('browser:selectTab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('browser:closeTab', tabId),
    handBack: () => ipcRenderer.invoke('browser:handBack')
  },

  engine: {
    installWsl: () => ipcRenderer.invoke('engine:installWsl')
  }
}

contextBridge.exposeInMainWorld('deskmates', deskmates)
