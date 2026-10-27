import { describe, expect, it } from 'vitest'
import {
  desktopContextCopyTarget,
  externalBrowserUrl,
  externalFilePath,
  localFilePath,
  localPdfPath,
  trustedRendererUrl,
} from '../src/desktop/renderer-security.js'
import { ownedDesktopHarnessOptions } from '../src/desktop/harness-security.js'

describe('desktop renderer trust boundary', () => {
  const origin = 'http://127.0.0.1:4317'

  it('starts a process-owned server on an OS-assigned loopback port', () => {
    expect(ownedDesktopHarnessOptions('/tmp/alto', false)).toEqual({
      projectRoot: '/tmp/alto',
      host: '127.0.0.1',
      port: 0,
      development: false,
      watch: true,
    })
  })

  it('allows only credential-free documents from Alto itself', () => {
    expect(trustedRendererUrl('http://127.0.0.1:4317/', origin)).toBe(true)
    expect(trustedRendererUrl('http://127.0.0.1:4317/thread/one?view=full', origin)).toBe(true)
    expect(trustedRendererUrl('http://user@127.0.0.1:4317/', origin)).toBe(false)
    expect(trustedRendererUrl('http://127.0.0.1:9000/', origin)).toBe(false)
    expect(trustedRendererUrl('https://attacker.example/', origin)).toBe(false)
    expect(trustedRendererUrl('file:///tmp/attacker.html', origin)).toBe(false)
    expect(trustedRendererUrl('data:text/html,attacker', origin)).toBe(false)
    expect(trustedRendererUrl('not a url', origin)).toBe(false)
  })

  it('hands only credential-free web links to the default browser', () => {
    expect(externalBrowserUrl('https://example.com/docs?q=alto')).toBe('https://example.com/docs?q=alto')
    expect(externalBrowserUrl('http://127.0.0.1:4317/')).toBe('http://127.0.0.1:4317/')
    expect(externalBrowserUrl('https://user@example.com/')).toBeUndefined()
    expect(externalBrowserUrl('file:///tmp/report.html')).toBeUndefined()
    expect(externalBrowserUrl('javascript:alert(1)')).toBeUndefined()
    expect(externalBrowserUrl('not a url')).toBeUndefined()
  })

  it('recognizes only local file URLs for native document opening', () => {
    expect(externalFilePath('file:///tmp/report.pdf')).toBe('/tmp/report.pdf')
    expect(externalFilePath('file:///tmp/report%20one.pdf#page=2')).toBe('/tmp/report one.pdf')
    expect(externalFilePath('file://localhost/tmp/report.pdf')).toBe('/tmp/report.pdf')
    expect(externalFilePath('file://server/share/report.pdf')).toBeUndefined()
    expect(externalFilePath('https://example.com/report.pdf')).toBeUndefined()
    expect(externalFilePath('javascript:alert(1)')).toBeUndefined()
    expect(externalFilePath('not a url')).toBeUndefined()
  })

  it('accepts only absolute local paths from the trusted renderer', () => {
    expect(localFilePath('/tmp/report.pdf')).toBe('/tmp/report.pdf')
    expect(localFilePath(' /tmp/report.pdf ')).toBe('/tmp/report.pdf')
    expect(localFilePath('report.pdf')).toBeUndefined()
    expect(localFilePath('/tmp/bad\0name.pdf')).toBeUndefined()
    expect(localFilePath('')).toBeUndefined()
  })

  it('narrows embedded PDF previews to absolute PDF paths', () => {
    expect(localPdfPath('/tmp/report.pdf')).toBe('/tmp/report.pdf')
    expect(localPdfPath('/tmp/REPORT.PDF')).toBe('/tmp/REPORT.PDF')
    expect(localPdfPath('/tmp/report.html')).toBeUndefined()
    expect(localPdfPath('report.pdf')).toBeUndefined()
  })

  it('copies ordinary links and decodes full local file paths', () => {
    expect(desktopContextCopyTarget('https://example.com/docs?q=alto')).toEqual({
      label: 'Copy Link',
      value: 'https://example.com/docs?q=alto',
    })
    expect(desktopContextCopyTarget('file:///Users/test/My%20Report.pdf#page=2')).toEqual({
      label: 'Copy Full Path',
      value: '/Users/test/My Report.pdf',
    })
    expect(desktopContextCopyTarget('', '/Users/test/source.ts')).toEqual({
      label: 'Copy Full Path',
      value: '/Users/test/source.ts',
    })
    expect(desktopContextCopyTarget('', 'Ordinary tooltip')).toBeUndefined()
  })
})
