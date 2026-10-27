import { startHarness } from './app.js'

const projectRoot = process.env.ALTO_ROOT ?? process.cwd()
const host = process.env.ALTO_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.ALTO_PORT ?? '4317', 10)

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid ALTO_PORT: ${process.env.ALTO_PORT}`)
}

let stopping = false
const harness = await startHarness({ projectRoot, host, port })
console.log(`Alto is running at ${harness.url}`)

async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`Stopping Alto (${signal})`)
  await harness.close()
}

process.once('SIGINT', () => void stop('SIGINT'))
process.once('SIGTERM', () => void stop('SIGTERM'))
