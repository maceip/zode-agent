import type {
  GitBranchInspectOptions,
  GitBranchState,
  GitInspectOptions,
  GitRepositoryState,
  GitSupportSnapshot,
} from './git-support-api.js'

export interface ClientGitSupportService {
  subscribe(listener: () => void): () => void
  snapshot(): GitSupportSnapshot
  repositoryFor(location: string): GitRepositoryState | undefined
  inspect(location: string, options?: GitInspectOptions): Promise<GitRepositoryState | undefined>
  inspectBranch(
    location: string,
    branch: string,
    options?: GitBranchInspectOptions,
  ): Promise<GitBranchState | undefined>
}

declare module 'cordis' {
  interface Context {
    clientGitSupport: ClientGitSupportService
  }
}
