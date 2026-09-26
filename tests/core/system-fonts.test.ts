import { describe, expect, it } from 'vitest'
import { parseFontRegistry } from '../../src/main/system-fonts'

describe('parseFontRegistry', () => {
  it('extracts the family name and drops type markers and style words', () => {
    const output = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '    Arial (TrueType)    REG_SZ    arial.ttf',
      '    Arial Bold (TrueType)    REG_SZ    arialbd.ttf',
      '    Arial Italic (TrueType)    REG_SZ    ariali.ttf',
      '    Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf',
      '    Segoe UI Semilight (TrueType)    REG_SZ    segoesisl.ttf',
      '    Calibri Light (TrueType)    REG_SZ    calibril.ttf',
      '    Franklin Gothic Medium (TrueType)    REG_SZ    framd.ttf'
    ].join('\n')
    expect(parseFontRegistry(output)).toEqual(['Arial', 'Calibri', 'Franklin Gothic', 'Segoe UI'])
  })

  it('keeps style words that are part of the family name', () => {
    const output = 'DejaVu Sans Mono (TrueType)    REG_SZ    dejavu.ttf'
    expect(parseFontRegistry(output)).toEqual(['DejaVu Sans Mono'])
  })

  it('splits multi-part families and dedupes case-insensitively', () => {
    const output = [
      'Agency FB & Agency FB Bold (TrueType)    REG_SZ    agency.ttf',
      'Cascadia Code (TrueType)    REG_SZ    cascadia.ttf',
      'CASCADIA CODE (TrueType)    REG_SZ    other.ttf'
    ].join('\n')
    expect(parseFontRegistry(output)).toEqual(['Agency FB', 'Cascadia Code'])
  })

  it('handles OpenType markers and empty input', () => {
    expect(parseFontRegistry('Georgia (OpenType)    REG_SZ    georgia.ttf')).toEqual(['Georgia'])
    expect(parseFontRegistry('')).toEqual([])
    expect(parseFontRegistry('   \n  \n')).toEqual([])
  })

  it('sorts locale-insensitively and case-insensitively', () => {
    const output = ['zapf.ttf', 'Apple Chancery', 'berlin.ttf', 'Verdana']
      .map((f) => `${f} (TrueType)    REG_SZ    f.ttf`)
      .join('\n')
    expect(parseFontRegistry(output)).toEqual(['Apple Chancery', 'berlin.ttf', 'Verdana', 'zapf.ttf'])
  })
})
