import type { HarnessOptions } from '../server/app.js'

export function ownedDesktopHarnessOptions(
  projectRoot: string,
  development: boolean,
): HarnessOptions {
  return {
    projectRoot,
    host: '127.0.0.1',
    // Desktop never discovers or reuses a fixed-port service. The OS assigns
    // a fresh port to the server this process starts and owns.
    port: 0,
    development,
    watch: true,
  }
}
