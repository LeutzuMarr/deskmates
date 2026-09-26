import { Menu, nativeImage, Tray } from 'electron'

export interface CreateTrayOptions {
  iconPath: string
  show(): void
  quit(): void
}

export function createTray({ iconPath, show, quit }: CreateTrayOptions): Tray {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  const tray = new Tray(icon)
  tray.setToolTip('Deskmates')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Deskmates', click: () => show() },
      { type: 'separator' },
      { label: 'Quit', click: () => quit() }
    ])
  )
  tray.on('click', () => show())
  return tray
}
