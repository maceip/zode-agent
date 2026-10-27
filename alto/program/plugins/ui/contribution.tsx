import { useEffect, useState, type ReactNode } from 'react'
import type { UiContribution, UiNode } from '../../../src/shared/protocol.js'
import type { Command } from '../../../src/client/commands.js'

function inputDefaults(
  nodes: UiNode[],
  values: Record<string, string> = {},
): Record<string, string> {
  for (const node of nodes) {
    if (node.type === 'input') values[node.id] = node.value ?? ''
    if (node.type === 'row' || node.type === 'group') inputDefaults(node.children, values)
  }
  return values
}

function NodeView({
  node,
  path,
  values,
  pending,
  setValue,
  act,
}: {
  node: UiNode
  path: string
  values: Record<string, string>
  pending: string | undefined
  setValue: (id: string, value: string) => void
  act: (actionId: string) => Promise<void>
}): ReactNode {
  switch (node.type) {
    case 'text':
      return <p className={`ui-text ui-tone-${node.tone ?? 'default'}`}>{node.text}</p>
    case 'metric':
      return (
        <div className={`ui-metric ui-tone-${node.tone ?? 'default'}`}>
          <span>{node.label}</span>
          <strong>{node.value}</strong>
        </div>
      )
    case 'list':
      return node.items.length ? (
        <div className="ui-list">
          {node.items.map((item, index) => (
            <div className={`ui-list-item ui-tone-${item.tone ?? 'default'}`} key={item.id ?? `${path}:${index}`}>
              <strong>{item.label}</strong>
              {item.detail && <span>{item.detail}</span>}
            </div>
          ))}
        </div>
      ) : <div className="ui-empty">{node.empty ?? 'Nothing here yet.'}</div>
    case 'input':
      return (
        <label className="ui-input">
          {node.label && <span>{node.label}</span>}
          <input
            type={node.inputType ?? 'text'}
            value={values[node.id] ?? ''}
            placeholder={node.placeholder}
            onChange={(event) => setValue(node.id, event.target.value)}
          />
        </label>
      )
    case 'button':
      return (
        <button
          className={`button ui-action ${node.variant === 'primary' ? 'primary' : node.variant === 'danger' ? 'danger' : 'ghost'}`}
          disabled={node.disabled || pending !== undefined}
          onClick={() => void act(node.action)}
        >
          {pending === node.action ? 'Working…' : node.label}
        </button>
      )
    case 'row':
    case 'group':
      return (
        <div className={node.type === 'row' ? 'ui-row' : 'ui-group'}>
          {node.title && <strong className="ui-group-title">{node.title}</strong>}
          {node.children.map((child, index) => (
            <NodeView
              node={child}
              path={`${path}:${index}`}
              values={values}
              pending={pending}
              setValue={setValue}
              act={act}
              key={`${path}:${index}`}
            />
          ))}
        </div>
      )
  }
}

export function Contribution({
  contribution,
  command,
}: {
  contribution: UiContribution
  command: Command
}): ReactNode {
  const [values, setValues] = useState(() => inputDefaults(contribution.nodes))
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const defaults = inputDefaults(contribution.nodes)
    setValues((current) => ({ ...defaults, ...current }))
  }, [contribution])

  const act = async (actionId: string): Promise<void> => {
    setPending(actionId)
    setError(undefined)
    try {
      await command('ui.action', {
        contributionId: contribution.id,
        actionId,
        values,
      })
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <section className="ui-contribution" data-ui-contribution={contribution.id}>
      {(contribution.title || contribution.description) && (
        <header>
          {contribution.title && <h2>{contribution.title}</h2>}
          {contribution.description && <p>{contribution.description}</p>}
        </header>
      )}
      <div className="ui-nodes">
        {contribution.nodes.map((node, index) => (
          <NodeView
            node={node}
            path={`${contribution.id}:${index}`}
            values={values}
            pending={pending}
            setValue={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
            act={act}
            key={`${contribution.id}:${index}`}
          />
        ))}
      </div>
      {error && <div className="ui-error">{error}</div>}
    </section>
  )
}
