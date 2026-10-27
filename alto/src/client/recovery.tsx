import { X } from 'lucide-react'
import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { ProgramPluginView } from '../shared/protocol.js'
import type {
  ClientHostService,
  ClientHostSnapshot,
} from './plugin-api.js'
import type { BrowserProgramState } from './plugin-runtime.js'

function RecoveryPanel({
  host,
  hostState,
  browserState,
  required,
  close,
}: {
  host: ClientHostService
  hostState: ClientHostSnapshot
  browserState: BrowserProgramState
  required: boolean
  close: () => void
}): ReactNode {
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const plugins = hostState.snapshot?.program.plugins ?? []

  const toggle = async (plugin: ProgramPluginView): Promise<void> => {
    setPending(plugin.id)
    setProblem(undefined)
    try {
      await host.command('program.plugin.setEnabled', {
        id: plugin.id,
        enabled: !plugin.enabled,
      })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div className="kernel-recovery" onMouseDown={() => !required && close()}>
      <section className="kernel-recovery-panel" role="dialog" aria-modal="true" aria-label="Cordis recovery" onMouseDown={(event) => event.stopPropagation()}>
        <header className="kernel-recovery-header">
          <h1>Cordis recovery</h1>
          {!required && <button type="button" aria-label="Close recovery" onClick={close}><X size={14} /></button>}
        </header>
        <p className="kernel-recovery-copy">
          {hostState.connected
            ? 'The native harness is connected. Restore or inspect the reloadable interface below.'
            : hostState.problem ?? 'Connecting to the native harness…'}
        </p>
        <div className="kernel-recovery-list">
          {plugins.map((plugin) => (
            <div className="kernel-recovery-row" style={{ marginLeft: `${plugin.depth * 12}px` }} key={plugin.id}>
              <span>{plugin.name}</span>
              <button type="button" disabled={pending !== undefined} onClick={() => void toggle(plugin)}>
                {plugin.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          ))}
          {!plugins.length && <span>No program entries are available yet.</span>}
        </div>
        {(problem || browserState.error) && (
          <div className="kernel-recovery-error" role="alert">{problem ?? browserState.error}</div>
        )}
      </section>
    </div>
  )
}

export function KernelRecovery({
  host,
  hostState,
  browserState,
  required = false,
}: {
  host: ClientHostService
  hostState: ClientHostSnapshot
  browserState: BrowserProgramState
  required?: boolean
}): ReactNode {
  const [open, setOpen] = useState(required)

  useEffect(() => {
    if (required) setOpen(true)
  }, [required])

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key.toLocaleLowerCase() !== 'p'
        || !event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
      ) return
      event.preventDefault()
      if (!event.repeat) setOpen((current) => !current)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  return (
    <>
      {open && (
        <RecoveryPanel
          host={host}
          hostState={hostState}
          browserState={browserState}
          required={required}
          close={() => setOpen(false)}
        />
      )}
    </>
  )
}
