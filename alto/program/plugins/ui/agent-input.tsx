import { Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { clientStyles } from '../../../src/client/plugin-api.js'
import { isRecord, type PendingServerRequest } from '../../../src/shared/protocol.js'

// ACP forms also cover MCP elicitations, including booleans and multiple choices.
// Use the same question controls and spacing as Alto's native agent questions.
export function AgentInputRequest({ request, resolve }: {
  request: PendingServerRequest
  resolve: (id: string | number, result: unknown) => Promise<void>
}): ReactNode {
  const schema = isRecord(request.params.schema) ? request.params.schema : {}
  const fields = isRecord(schema.properties) ? Object.entries(schema.properties).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) : []
  const required = Array.isArray(schema.required) ? schema.required : []
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.flatMap(([key, field]) => field.default !== undefined ? [[key, field.default]] : field.type === 'boolean' ? [[key, false]] : [])))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const update = (key: string, value: unknown) => setValues((previous) => ({ ...previous, [key]: value }))
  const submit = async (action: string): Promise<void> => {
    if (sending) return
    setSending(true); setError('')
    try { await resolve(request.id, { action, ...(action === 'accept' ? { content: values } : {}) }) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSending(false) }
  }
  return <form className={clientStyles.floatingPanel + ' input-request'} aria-label="Agent questions" aria-busy={sending}
    onSubmit={(event) => { event.preventDefault(); void submit('accept') }}>
    <div className="input-request-heading">Your input is needed</div>
    <p>{String(request.params.message ?? '')}</p>
    {fields.map(([key, field]) => {
      const items = isRecord(field.items) ? field.items : field
      const variants = Array.isArray(items.oneOf) ? items.oneOf : Array.isArray(items.anyOf) ? items.anyOf : []
      const options = variants.filter(isRecord).map((option) => ({ value: String(option.const), label: String(option.title ?? option.const) }))
      if (!options.length && Array.isArray(items.enum)) options.push(...items.enum.map((value) => ({ value: String(value), label: String(value) })))
      const many = field.type === 'array'
      const selected = (value: string) => many ? Array.isArray(values[key]) && values[key].includes(value) : values[key] === value
      return <fieldset className="input-question" key={key} disabled={sending}>
        <legend><span className="input-question-title">{String(field.description ?? field.title ?? key)}</span></legend>
        {options.length > 0 ? <div className="input-question-options">{options.map((option) => <label className="input-question-option" key={option.value}>
          <input type={many ? 'checkbox' : 'radio'} name={request.id + ':' + key} checked={selected(option.value)} required={!many && required.includes(key)}
            onChange={() => update(key, many ? selected(option.value) ? (values[key] as string[]).filter((value) => value !== option.value) : [...(Array.isArray(values[key]) ? values[key] : []), option.value] : option.value)} />
          <span className="input-question-indicator" aria-hidden="true">{selected(option.value) && <Check size={14} />}</span>
          <span className="input-question-option-copy">{option.label}</span>
        </label>)}</div> : field.type === 'boolean' ? <label className="input-question-option">
          <input type="checkbox" checked={values[key] === true} onChange={(event) => update(key, event.target.checked)} />
          <span className="input-question-indicator" aria-hidden="true">{values[key] === true && <Check size={14} />}</span><span>Yes</span>
        </label> : <label className="input-question-custom"><span>Answer</span><input
          type={field.type === 'integer' || field.type === 'number' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
          step={field.type === 'number' ? 'any' : undefined}
          min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined}
          minLength={typeof field.minLength === 'number' ? field.minLength : undefined} maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}
          required={required.includes(key)} value={String(values[key] ?? '')} autoComplete="off"
          onChange={(event) => update(key, field.type === 'number' || field.type === 'integer' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)} /></label>}
      </fieldset>
    })}
    {error && <p className="input-request-error" role="alert">{error}</p>}
    <div className="input-request-actions">
      <button type="button" className={clientStyles.button + ' ghost'} disabled={sending} onClick={() => void submit('decline')}>Skip</button>
      <button type="submit" className={clientStyles.button + ' primary'} disabled={sending}>{sending ? 'Sending…' : 'Continue'}</button>
    </div>
  </form>
}
