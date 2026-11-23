import { describe, expect, it } from 'vitest'
import type { Rollup } from 'vite'
import { notesFiles } from '../../scripts/notes-precache'

function chunk(fileName: string, extra: Partial<Rollup.OutputChunk> & { css?: string[]; assets?: string[] } = {}): Rollup.OutputChunk {
  return {
    type: 'chunk',
    fileName,
    isEntry: false,
    facadeModuleId: null,
    imports: [],
    dynamicImports: [],
    viteMetadata: { importedCss: new Set(extra.css ?? []), importedAssets: new Set(extra.assets ?? []) },
    ...extra
  } as unknown as Rollup.OutputChunk
}

const asset = (fileName: string, source: string): Rollup.OutputAsset => ({ type: 'asset', fileName, source }) as unknown as Rollup.OutputAsset

describe('notes precache list', () => {
  it('keeps everything the notes page loads, and nothing of the rest of Deskmates', () => {
    const bundle: Rollup.OutputBundle = {
      'assets/notes.js': chunk('assets/notes.js', { isEntry: true, facadeModuleId: 'C:\\app\\src\\renderer\\notes.html', imports: ['assets/react.js'], dynamicImports: ['assets/pair.js'], css: ['assets/notes.css'] }),
      'assets/react.js': chunk('assets/react.js'),
      'assets/pair.js': chunk('assets/pair.js', { dynamicImports: ['assets/jsqr.js', 'assets/react.js'] }),
      'assets/jsqr.js': chunk('assets/jsqr.js'),
      'assets/notes.css': asset('assets/notes.css', "@font-face{src:url(/assets/font.woff2) format('woff2')}"),
      'assets/font.woff2': asset('assets/font.woff2', ''),
      'assets/main.js': chunk('assets/main.js', { isEntry: true, facadeModuleId: '/app/src/renderer/remote.html', imports: ['assets/react.js', 'assets/katex.js'] }),
      'assets/katex.js': chunk('assets/katex.js')
    }
    expect(notesFiles(bundle, 'notes.html')).toEqual(['assets/font.woff2', 'assets/jsqr.js', 'assets/notes.css', 'assets/notes.js', 'assets/pair.js', 'assets/react.js'])
  })

  it('fails the build when the notes page is missing', () => {
    expect(() => notesFiles({}, 'notes.html')).toThrow(/no entry chunk/)
  })
})
