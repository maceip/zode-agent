import { isRecord, type JsonValue } from '../../src/shared/protocol.js'

export const CODE_TOUR_GENERATE_METHOD = 'code-tour.generate'
export const CODE_TOUR_PANE_KIND = 'code-tour'

export interface GeneratedCodeTourStop {
  path: string
  label: string
  title: string
  markdown: string
}

export interface GeneratedCodeTour {
  title: string
  overview: string
  stops: readonly GeneratedCodeTourStop[]
}

export interface CodeTourGenerationResponse {
  model: string
  effort: string
  tour: GeneratedCodeTour
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Codex returned a tour without ${field}`)
  }
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`Codex returned an oversized tour ${field}`)
  return text
}

function parsedTour(value: unknown): GeneratedCodeTour {
  if (!isRecord(value) || !Array.isArray(value.stops) || value.stops.length === 0) {
    throw new Error('Codex returned an invalid code tour')
  }
  if (value.stops.length > 20) throw new Error('Codex returned too many tour stops')
  const stops = value.stops.map((stop): GeneratedCodeTourStop => {
    if (!isRecord(stop)) throw new Error('Codex returned an invalid tour stop')
    return {
      path: requiredText(stop.path, 'stop path', 1_000),
      label: requiredText(stop.label, 'stop label', 80),
      title: requiredText(stop.title, 'stop title', 200),
      markdown: requiredText(stop.markdown, 'stop explanation', 12_000),
    }
  })
  return {
    title: requiredText(value.title, 'title', 200),
    overview: requiredText(value.overview, 'overview', 12_000),
    stops,
  }
}

/** Accepts strict JSON and tolerates a single accidental JSON code fence. */
export function parseGeneratedCodeTourText(output: string): GeneratedCodeTour {
  const trimmed = output.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1]
  const candidate = fenced ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Codex did not return code tour JSON')
  try {
    return parsedTour(JSON.parse(candidate.slice(start, end + 1)))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Codex returned malformed code tour JSON')
    throw error
  }
}

export function parseCodeTourGenerationResponse(value: JsonValue): CodeTourGenerationResponse {
  if (!isRecord(value)) throw new Error('Alto returned an invalid code tour response')
  return {
    model: requiredText(value.model, 'model', 200),
    effort: requiredText(value.effort, 'reasoning effort', 40),
    tour: parsedTour(value.tour),
  }
}
