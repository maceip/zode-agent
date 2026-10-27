import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function trustedRendererUrl(value: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(value)
    const origin = new URL(expectedOrigin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
      && url.origin === origin.origin
  } catch {
    return false
  }
}

export function externalFilePath(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'file:'
      || url.username !== ''
      || url.password !== ''
      || (url.hostname !== '' && url.hostname !== 'localhost')
    ) return undefined
    return localFilePath(fileURLToPath(url))
  } catch {
    return undefined
  }
}

export function localFilePath(value: string): string | undefined {
  const candidate = value.trim()
  return candidate && !candidate.includes('\0') && path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : undefined
}

export function localPdfPath(value: string): string | undefined {
  const candidate = localFilePath(value)
  return candidate && path.extname(candidate).toLowerCase() === '.pdf'
    ? candidate
    : undefined
}

export function externalBrowserUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
    ) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export interface DesktopLinkCopyTarget {
  label: 'Copy Link' | 'Copy Full Path'
  value: string
}

export function desktopContextCopyTarget(
  linkUrl: string,
  titleText = '',
): DesktopLinkCopyTarget | undefined {
  const titledPath = localFilePath(titleText)
  if (titledPath) return { label: 'Copy Full Path', value: titledPath }
  const value = linkUrl.trim()
  if (!value) return undefined
  const filePath = externalFilePath(value)
  return filePath
    ? { label: 'Copy Full Path', value: filePath }
    : { label: 'Copy Link', value }
}
