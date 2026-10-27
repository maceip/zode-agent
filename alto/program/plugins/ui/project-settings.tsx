import {
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import {
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type {
  LocalProject,
  LocalProjectInput,
} from '../../../src/shared/protocol.js'
import { ConversationPaneOverlay } from './conversation-overlay.js'

interface ProjectDraft {
  id?: string
  name: string
  primaryRoot: string
  additionalRoots: string
}

function folderName(folder: string): string {
  return folder.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

function draftFor(project: LocalProject): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    primaryRoot: project.primaryRoot,
    additionalRoots: project.roots
      .filter((root) => root !== project.primaryRoot)
      .join('\n'),
  }
}

function projectInput(draft: ProjectDraft): LocalProjectInput {
  const primaryRoot = draft.primaryRoot.trim()
  const additionalRoots = draft.additionalRoots
    .split(/\r?\n/)
    .map((root) => root.trim())
    .filter(Boolean)
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim() || folderName(primaryRoot),
    primaryRoot,
    roots: [primaryRoot, ...additionalRoots],
  }
}

function ProjectFields({
  draft,
  focusPrimary = false,
  onChange,
}: {
  draft: ProjectDraft
  focusPrimary?: boolean
  onChange: (draft: ProjectDraft) => void
}): ReactNode {
  return (
    <>
      <label>
        <span>Primary folder</span>
        <input
          value={draft.primaryRoot}
          autoFocus={focusPrimary}
          required
          placeholder="/path/to/project"
          onChange={(event) => onChange({
            ...draft,
            primaryRoot: event.target.value,
          })}
        />
      </label>
      <label>
        <span>Name <small>optional</small></span>
        <input
          value={draft.name}
          placeholder={folderName(draft.primaryRoot) || 'Workspace name'}
          onChange={(event) => onChange({
            ...draft,
            name: event.target.value,
          })}
        />
      </label>
      <label>
        <span>Attached folders <small>one per line</small></span>
        <textarea
          value={draft.additionalRoots}
          rows={2}
          placeholder="/path/to/related-repository"
          onChange={(event) => onChange({
            ...draft,
            additionalRoots: event.target.value,
          })}
        />
      </label>
    </>
  )
}

export function ProjectSettings({
  projects,
  activeProjectId,
  workspace,
  disabled,
  onSelect,
  onSave,
  onRemove,
}: {
  projects: LocalProject[]
  activeProjectId?: string
  workspace: string
  disabled: boolean
  onSelect: (project: LocalProject) => void
  onSave: (project: LocalProjectInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState<ProjectDraft>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!draft || busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      await onSave(projectInput(draft))
      setDraft(undefined)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id || busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      await onRemove(draft.id)
      setDraft(undefined)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="project-settings">
      <header>
        <span>Folders</span>
        <button
          type="button"
          aria-label="Add workspace"
          title="Add workspace"
          disabled={disabled || busy}
          onClick={() => {
            setProblem(undefined)
            setDraft({
              name: folderName(workspace),
              primaryRoot: workspace,
              additionalRoots: '',
            })
          }}
        >
          <Plus size={14} />
        </button>
      </header>

      <div className="project-settings-list">
        {projects.map((project) => (
          <div
            className={`project-settings-row ${project.id === activeProjectId ? 'active' : ''} ${project.source ? 'managed' : ''}`}
            key={project.id}
          >
            <button
              className="project-settings-select"
              type="button"
              disabled={disabled}
              title={project.primaryRoot}
              onClick={() => onSelect(project)}
            >
              <Folder size={15} />
              <span>
                <strong>{project.name}</strong>
                <small>{project.primaryRoot}</small>
              </span>
            </button>
            {!project.source && (
              <button
                className="project-settings-edit"
                type="button"
                aria-label={`Edit ${project.name}`}
                title={`Edit ${project.name}`}
                disabled={disabled || busy}
                onClick={() => {
                  setProblem(undefined)
                  setDraft(draftFor(project))
                }}
              >
                <Pencil size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {draft && (
        <form className="project-settings-form" onSubmit={(event) => void submit(event)}>
          <header>
            <strong>{draft.id ? 'Edit workspace' : 'New workspace'}</strong>
            <button type="button" aria-label="Cancel" onClick={() => setDraft(undefined)}>
              <X size={13} />
            </button>
          </header>
          <ProjectFields
            draft={draft}
            focusPrimary={!draft.id}
            onChange={setDraft}
          />
          {problem && <div className="project-settings-error" role="alert">{problem}</div>}
          <footer>
            {draft.id && (
              <button className="project-settings-remove" type="button" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={13} />
                Remove
              </button>
            )}
            <button className="project-settings-save" type="submit" disabled={busy}>Save</button>
          </footer>
        </form>
      )}
    </section>
  )
}

export function NewWorkspaceDialog({
  disabled,
  onClose,
  onCreate,
}: {
  disabled: boolean
  onClose: () => void
  onCreate: (project: LocalProjectInput) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState<ProjectDraft>({
    name: '',
    primaryRoot: '',
    additionalRoots: '',
  })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || disabled) return
    setBusy(true)
    setProblem(undefined)
    try {
      await onCreate(projectInput(draft))
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConversationPaneOverlay
      className="workspace-creator-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="workspace-creator"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-creator-title"
        aria-describedby="workspace-creator-description"
      >
        <header>
          <span className="workspace-creator-icon" aria-hidden="true"><FolderPlus size={18} /></span>
          <div>
            <strong id="workspace-creator-title">New workspace</strong>
            <p id="workspace-creator-description">Group chats around one or more local folders.</p>
          </div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <form className="workspace-creator-form" onSubmit={(event) => void submit(event)}>
          <ProjectFields draft={draft} focusPrimary onChange={setDraft} />
          {problem && <div className="project-settings-error" role="alert">{problem}</div>}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={busy || disabled}>
              {busy ? 'Creating…' : 'Create workspace'}
            </button>
          </footer>
        </form>
      </section>
    </ConversationPaneOverlay>
  )
}
