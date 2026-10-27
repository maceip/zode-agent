import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const featureRoot = path.join(root, 'program', 'plugins')
const baselinePath = path.join(root, 'scripts', 'design-system-audit-baseline.json')
const ignoredFiles = new Set(['theme.css'])

const rules = {
  rawFontSize: /font-size\s*:\s*-?(?:\d*\.)?\d+(?:px|rem|em)\b/gi,
  rawFontWeight: /font-weight\s*:\s*\d+\b/gi,
  rawRadius: /border(?:-[a-z]+)?-radius\s*:\s*(?!0(?:\D|$))-?(?:\d*\.)?\d+(?:px|rem|em)\b/gi,
  rawSpacing: /(?:^|[;{]\s*)(?:margin|padding|gap|row-gap|column-gap|top|right|bottom|left)(?:-[a-z]+)?\s*:\s*[^;{}]*?(?:\d*\.)?\d+px\b/gim,
  rawGeometry: /(?:^|[;{]\s*)(?:min-|max-)?(?:width|height)\s*:\s*[^;{}]*?(?:\d*\.)?\d+px\b/gim,
  rawColor: /(?:color|background|border(?:-[a-z]+)?-color|outline-color|fill|stroke)\s*:\s*[^;{}]*(?:#[\da-f]{3,8}\b|(?:rgb|hsl)a?\()/gi,
  rawShadow: /(?:box|text)-shadow\s*:\s*(?!none\b|var\()[^;{}]*(?:\d*\.)?\d+px\b/gi,
  negativeTracking: /letter-spacing\s*:\s*-[^;{}]+/gi,
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(absolute)
    if (!entry.isFile() || !/\.(?:css|tsx)$/.test(entry.name)) return []
    if (ignoredFiles.has(entry.name)) return []
    return [absolute]
  })
}

function collect() {
  const files = {}
  for (const absolute of walk(featureRoot)) {
    const source = fs.readFileSync(absolute, 'utf8')
    const counts = {}
    for (const [name, pattern] of Object.entries(rules)) {
      pattern.lastIndex = 0
      const count = [...source.matchAll(pattern)].length
      if (count > 0) counts[name] = count
    }
    if (absolute.endsWith('.tsx')) {
      const inlineStyle = (source.match(/\bstyle\s*=\s*\{\{/g) ?? []).length
      if (inlineStyle > 0) counts.inlineStyle = inlineStyle
    }
    if (Object.keys(counts).length > 0) {
      files[path.relative(root, absolute)] = counts
    }
  }
  return { version: 1, files }
}

const current = collect()
if (process.argv.includes('--print-baseline')) {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`)
  process.exit(0)
}

if (!fs.existsSync(baselinePath)) {
  console.error('Design-system audit baseline is missing. Run with --print-baseline and check in the result.')
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
const failures = []
const stale = []
const files = new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(current.files)])
for (const file of [...files].sort()) {
  const expected = baseline.files?.[file] ?? {}
  const actual = current.files[file] ?? {}
  const categories = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const category of [...categories].sort()) {
    const allowed = expected[category] ?? 0
    const found = actual[category] ?? 0
    if (found > allowed) failures.push(`${file}: ${category} ${found} (baseline ${allowed})`)
    if (found < allowed) stale.push(`${file}: ${category} ${found} (baseline ${allowed})`)
  }
}

if (failures.length > 0) {
  console.error('Design-system audit found new raw feature styling:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

if (stale.length > 0) {
  console.error('Design-system audit baseline is stale after styling was removed:')
  for (const entry of stale) console.error(`  ${entry}`)
  console.error('Regenerate the baseline with --print-baseline and check in the lower counts.')
  process.exit(1)
}

console.log(`Design-system audit passed (${Object.keys(current.files).length} feature files ratcheted).`)
