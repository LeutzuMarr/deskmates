/** Starts sync when the device has a notes library, and keeps the screens up to date with it. */
import { appExtras } from '../App'
import { localChange, listItems, listPages } from '../db'
import { notebookExtras } from '../editor/NotebookView'
import { restoreLibrary } from '../../remote/device'
import { SyncBadge } from './SyncBadge'
import { syncer } from './sync'
import { loadTemplates } from '../templates/registry'

// Templates made or installed on another device show up without reopening the app.
syncer.onChange((change) => {
  if (change.stores.has('templates')) void loadTemplates()
})

localChange.add(() => syncer.soon())

const previousOnDevice = appExtras.onDevice
appExtras.onDevice = (device) => {
  previousOnDevice?.(device)
  void restoreLibrary(device).then((access) => syncer.start(access))
}

const previousHeader = appExtras.headerStart
appExtras.headerStart = (device, online) => (
  <>
    {previousHeader?.(device, online)}
    <SyncBadge />
  </>
)

// An open notebook picks up pages and ink that arrive from another device.
notebookExtras.setup = [
  ...(notebookExtras.setup ?? []),
  (engine) =>
    syncer.onChange((change) => {
      if (!change.notebooks.has(engine.notebookId) && !change.stores.has('assets')) return
      void Promise.all([listPages(engine.notebookId), listItems(engine.notebookId)]).then(([pages, items]) => {
        if (pages.length) engine.load(pages, items)
      })
    })
]
