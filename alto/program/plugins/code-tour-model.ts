import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import type { GeneratedCodeTour } from './code-tour-api.js'
import type { DiffReviewDocument } from './diff-viewer-api.js'

export interface CodeTourStop {
  id: string
  label: string
  heading: string
  markdown: string
  path: string
  additions: number
  deletions: number
  fileDiff: FileDiffMetadata
}

export interface CodeTourDocument {
  id: string
  title: string
  intro: string
  model: string
  effort: string
  additions: number
  deletions: number
  stops: readonly CodeTourStop[]
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\*_{}\[\]()<>#+.!|-])/gu, '\\$1')
}

function lineCounts(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  return fileDiff.hunks.reduce((total, hunk) => ({
    additions: total.additions + hunk.additionLines,
    deletions: total.deletions + hunk.deletionLines,
  }), { additions: 0, deletions: 0 })
}

export function codeTourFiles(document: DiffReviewDocument): readonly FileDiffMetadata[] {
  return parsePatchFiles(document.patch, document.id, true).flatMap((patch) => patch.files)
}

export function codeTourPaths(document: DiffReviewDocument): string[] {
  return [...new Set(codeTourFiles(document).map((file) => file.name))]
}

export function emptyCodeTour(
  document: DiffReviewDocument,
  model: string,
  effort: string,
): CodeTourDocument {
  return {
    id: document.id,
    title: document.title,
    intro: `# ${escapeMarkdownText(document.title)}`,
    model,
    effort,
    additions: 0,
    deletions: 0,
    stops: [],
  }
}

/** Binds model-authored stops to the exact parsed file diffs they describe. */
export function materializeCodeTour(
  document: DiffReviewDocument,
  generated: GeneratedCodeTour,
  model: string,
  effort: string,
): CodeTourDocument {
  const files = codeTourFiles(document)
  const byPath = new Map(files.map((file) => [file.name, file]))
  const used = new Set<string>()
  let additions = 0
  let deletions = 0
  // A model can repeat a valid path when it finds multiple ideas in one file.
  // Keep the first stop so one duplicate does not discard the whole tour.
  const stops = generated.stops.filter((stop) => {
    if (used.has(stop.path)) return false
    used.add(stop.path)
    return true
  }).map((stop, index): CodeTourStop => {
    const fileDiff = byPath.get(stop.path)
    if (!fileDiff) throw new Error(`Codex referenced a file outside this diff: ${stop.path}`)
    const counts = lineCounts(fileDiff)
    additions += counts.additions
    deletions += counts.deletions
    return {
      id: `${document.id}:${index}:${fileDiff.name}`,
      label: stop.label,
      heading: escapeMarkdownText(stop.title),
      markdown: stop.markdown,
      path: fileDiff.name,
      additions: counts.additions,
      deletions: counts.deletions,
      fileDiff,
    }
  })

  return {
    id: document.id,
    title: generated.title,
    intro: `# ${escapeMarkdownText(generated.title)}\n\n${generated.overview}`,
    model,
    effort,
    additions,
    deletions,
    stops,
  }
}
