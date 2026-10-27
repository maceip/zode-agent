export const PDF_VIEWER_INSPECT_METHOD = 'pdf-viewer.inspect'

export interface PdfDocument {
  path: string
  name: string
  size: number
  modifiedAt: number
}
