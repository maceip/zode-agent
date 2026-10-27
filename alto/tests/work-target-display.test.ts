import { describe, expect, it } from 'vitest'
import { workTargetDisplay } from '../program/plugins/work-target-display.js'
import type { WorkCheckout } from '../program/plugins/work-contexts-api.js'

const local: WorkCheckout = {
  id: 'local', kind: 'local', projectId: 'alto', branch: 'main', label: 'Alto', location: '/work/alto',
}
const blox: WorkCheckout = {
  ...local, id: 'blox-feature', kind: 'blox', branch: 'feature', location: 'alto-feature',
  url: 'https://blox.example/workstations/alto-feature',
}
const providers = [{ id: 'blox', label: 'Blox', supportsExistingTarget: true, supportsBranchTarget: true }]
const session = {
  remoteLocation: 'Blox', remoteWorkspaceName: 'alto-feature', providerId: 'blox:codex',
  providers: [{ id: 'blox:codex', label: 'Codex on Blox', location: { id: 'blox', label: 'Blox' } }],
}

describe('pane execution location', () => {
  it('uses the selected checkout for the local folder and remote link', () => {
    expect(workTargetDisplay({}, local, [], providers)).toMatchObject({
      local: true, label: 'Local', location: '/work/alto', checkoutId: 'local', branch: 'main',
    })
    expect(workTargetDisplay({}, blox, [local], providers)).toMatchObject({
      local: false, label: 'Blox', location: 'alto-feature', branch: 'feature', url: blox.url,
    })
  })

  it('prefers the running remote workspace over the local checkout and selected target', () => {
    const display = workTargetDisplay({ ...session, remoteWorkspace: {
      name: 'actual-workstation', branch: 'remote-fix', url: 'https://blox.example/workstations/actual',
    } }, blox, [local, blox], providers)
    expect(display).toMatchObject({
      local: false, label: 'Blox', location: 'actual-workstation', branch: 'remote-fix',
      url: 'https://blox.example/workstations/actual',
    })
    expect(display?.checkoutId).toBeUndefined()
  })

  it('finds a legacy remote target only by its matching provider and workstation', () => {
    expect(workTargetDisplay(session, local, [local, blox], providers)).toMatchObject({
      branch: 'feature', url: blox.url,
    })
    const unrelated = { ...blox, kind: 'other-provider', branch: 'wrong' }
    const display = workTargetDisplay(session, local, [local, unrelated], providers)
    expect(display).toEqual({ local: false, label: 'Blox', location: 'alto-feature' })
  })

  it('does not report a local branch or link when remote metadata is unavailable', () => {
    expect(workTargetDisplay({ remoteLocation: 'Blox' }, local, [local, blox], providers))
      .toEqual({ local: false, label: 'Blox', location: 'Blox' })
    expect(workTargetDisplay({}, undefined, [], providers)).toBeUndefined()
  })

  it('only links to HTTP web destinations without embedded credentials', () => {
    for (const url of ['javascript:alert(1)', 'file:///local/path', 'https://user:password@blox.example', '/relative']) {
      expect(workTargetDisplay({}, { ...blox, url }, [], providers)?.url).toBeUndefined()
      expect(workTargetDisplay({ ...session, remoteWorkspace: { url } }, local, [], providers)?.url).toBeUndefined()
    }
  })
})
