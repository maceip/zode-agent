const SOURCE_EXTENSIONS = [
  '.astro', '.bazel', '.bzl', '.c', '.cc', '.cfg', '.clj', '.cljs', '.conf', '.cpp',
  '.cs', '.css', '.dart', '.diff', '.edn', '.env', '.erl', '.ex', '.exs', '.fs',
  '.fsx', '.go', '.gql', '.gradle', '.graphql', '.h', '.hcl', '.hpp', '.hrl', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.lock', '.log', '.lua',
  '.m', '.mdx', '.mm', '.nix', '.patch', '.php', '.pl', '.pm', '.properties', '.proto',
  '.py', '.r', '.rb', '.rs', '.scala', '.scss', '.sh', '.sql', '.svelte', '.swift',
  '.tf', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zig',
] as const
const SOURCE_NAMES = new Set([
  '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore',
  'build', 'buck', 'dockerfile', 'gemfile', 'justfile', 'makefile', 'meson.build',
  'procfile', 'rakefile', 'workspace',
])

export function sourcePath(filePath: string): boolean {
  const normalized = filePath.trim().toLocaleLowerCase()
  const name = normalized.replaceAll('\\', '/').split('/').at(-1) ?? normalized
  return SOURCE_NAMES.has(name) || SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
}
