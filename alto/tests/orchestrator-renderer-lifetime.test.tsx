import type { Context } from 'cordis'
import type { ReactElement } from 'react'
import { expect, it, vi } from 'vitest'
import orchestratorClient from '../program/plugins/orchestrator.client.js'

it('keeps published agent renderers usable while their owning fiber is replaced', () => {
  const renderers: Array<(props: object) => ReactElement<{ host: unknown }>> = []
  const host = {}
  let active = true
  const ctx = new Proxy({
    clientHost: host,
    clientSession: {},
    clientMarkdown: {},
    clientUi: {
      overlays: {},
      registerStyle: vi.fn(),
      registerRoot: (_owner: unknown, _id: string, renderer: typeof renderers[number]) => renderers.push(renderer),
      registerComponent: (_owner: unknown, _id: string, renderer: typeof renderers[number]) => renderers.push(renderer),
    },
    provide: vi.fn(),
    effect: vi.fn(),
  }, {
    get(target, key, receiver) {
      if (!active && typeof key === 'string' && key.startsWith('client')) {
        throw new Error(`Cannot read ${key} from an inactive context`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
  ;(orchestratorClient as (ctx: Context) => void)(ctx as unknown as Context)
  active = false
  expect(renderers).toHaveLength(2)
  for (const render of renderers) expect(render({ session: {}, render: vi.fn() }).props.host).toBe(host)
})
