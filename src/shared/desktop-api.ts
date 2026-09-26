import type { ProviderId, FontChoice, AnimationChoice } from './protocol'

export interface CoreConnection {
  port: number
  token: string
}

export type DesignExportFormat = 'html' | 'pdf' | 'png'

/** Video export settings; unset values come from the page (the motion-stage engine declares them). */
export interface VideoExportOptions {
  format: 'mp4' | 'webm' | 'gif'
  width?: number
  height?: number
  fps?: number
  /** Length in seconds. */
  duration?: number
}

/**
 * What `engine.installWsl()` resolves to. A declined administrator prompt is `cancelled`, not a
 * rejection — the caller decides what that means, but it's a choice the user made, not a failure.
 * `needs-restart` is the expected outcome of a successful run: enabling WSL needs a reboot before
 * it's usable, so this never claims WSL is ready right after the elevated command returns.
 */
export type InstallWslResult = { outcome: 'needs-restart' } | { outcome: 'cancelled' } | { outcome: 'error'; message: string }

/** API that the preload script exposes to the renderer as `window.deskmates`. */
export interface DesktopApi {
  getCoreConnection(): Promise<CoreConnection>
  onCoreRestarted(listener: () => void): () => void
  secrets: {
    status(): Promise<ProviderId[]>
    set(provider: ProviderId, key: string | null): Promise<ProviderId[]>
  }
  pickFolder(): Promise<string | null>
  openPath(path: string): Promise<void>
  autoStart: {
    get(): Promise<boolean>
    set(enabled: boolean): Promise<boolean>
  }
  appearance: {
    pickImage(): Promise<string | null>
    pickFont(): Promise<FontChoice | null>
    pickAnimation(): Promise<AnimationChoice | null>
    setWindowIcon(dataUrl: string | null): Promise<void>
  }
  design: {
    /**
     * Asks where to save, then exports the design without editor artifacts. `width` is the page width in
     * CSS pixels for PDF and PNG (default 1440); `file` is the design-relative page to export (default
     * index.html). Resolves to the saved path, or null if the user cancelled.
     */
    export(projectId: string, format: DesignExportFormat, width?: number, file?: string): Promise<string | null>
    /** Asks where to save, then records `file` of the design to a video. Resolves to the path, or null if cancelled. */
    exportVideo(projectId: string, file: string, options: VideoExportOptions): Promise<string | null>
    /** Stops the recording in progress. */
    cancelVideo(): Promise<void>
    /** Recording progress from 0 to 1; returns an unsubscribe function. */
    onVideoProgress(listener: (fraction: number) => void): () => void
    /** Font family names installed on this PC, sorted and without duplicates. */
    systemFonts(): Promise<string[]>
  }
  engine: {
    /**
     * Runs exactly `wsl.exe --install --no-distribution`, elevated through a Windows administrator
     * prompt — always that one fixed command, nothing the renderer supplies. Resolves once the
     * elevated process has finished; never rejects just because the user declined the prompt.
     */
    installWsl(): Promise<InstallWslResult>
  }
}
