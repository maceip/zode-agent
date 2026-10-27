import { describe, expect, it } from 'vitest'
import {
  codexSessionDefaults,
  permissionSettings,
} from '../src/server/services/codex-service.js'

describe('Codex permission modes', () => {
  it('keeps Ask and Auto in the workspace sandbox while changing the reviewer', () => {
    expect(permissionSettings('ask', '/work/project')).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/project'] },
    })
    expect(permissionSettings('auto', '/work/project')).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/project'] },
    })
  })

  it('maps Full to unrestricted execution without approval prompts', () => {
    expect(permissionSettings('full', '/work/project')).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('derives the initial session from the effective Codex config', () => {
    expect(codexSessionDefaults({
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'max',
      default_permissions: ':danger-full-access',
      approval_policy: 'never',
    }, [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    }])).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'max',
      permissionMode: 'full',
    })
  })

  it('falls back to model metadata and the interactive permission mode', () => {
    expect(codexSessionDefaults(undefined, [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    }])).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'medium',
      permissionMode: 'ask',
    })
  })
})
