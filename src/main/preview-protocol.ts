import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { PREVIEW_SCHEME } from '../shared/design-bridge'
import { injectEditor, isDesignComponentPath, previewResponseHeaders, resolvePreviewRequest } from './preview-files'
import { injectClock } from './video-clock'

/** Registers the preview scheme as privileged. Must run before the app is ready. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

const notFound = (): Response =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  })

/** Serves design files, the editor script and the DC runtime on the preview scheme for the default session. */
export function handlePreviewProtocol(dataDir: string, editorScriptPath: string, dcSupportPath?: string): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const resolved = resolvePreviewRequest(request.url, dataDir, editorScriptPath, dcSupportPath)
    if (resolved.kind === 'not-found') return notFound()

    try {
      if (resolved.isHtml) {
        const url = new URL(request.url)
        const isRecording = url.searchParams.get('record') === '1'
        const isExport = isRecording || url.searchParams.get('export') === '1'
        let html = await readFile(resolved.path, 'utf8')
        if (isRecording) html = injectClock(html)
        else if (!isExport && !isDesignComponentPath(resolved.path)) html = injectEditor(html)
        return new Response(html, { headers: previewResponseHeaders(resolved.contentType, true) })
      }

      const data = await readFile(resolved.path)
      return new Response(data, { headers: previewResponseHeaders(resolved.contentType, false) })
    } catch {
      // The file may have vanished between resolving and reading; never leak paths.
      return notFound()
    }
  })
}