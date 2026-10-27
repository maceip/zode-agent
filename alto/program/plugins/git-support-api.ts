import type { Context } from 'cordis'

export type GitCheckState = 'pending' | 'passing' | 'failing'

export interface GitChangedFile {
  path: string
  indexStatus: string
  worktreeStatus: string
  previousPath?: string
}

export interface GitCheckDetail {
  name: string
  state: GitCheckState
  description?: string
  url?: string
}

export interface GitPullRequestStack {
  id: string
  number: number
  baseBranch: string
  size: number
  entries: Array<{
    /** GitHub's position, starting at 1 for the PR closest to the base branch. */
    position: number
    pullRequest: Omit<GitPullRequest, 'stack'>
  }>
}

export interface GitPullRequest {
  number: number
  title: string
  url: string
  state: string
  draft: boolean
  headBranch: string
  baseBranch: string
  checks?: GitCheckState
  checkDetails?: GitCheckDetail[]
  checkCount?: number
  stack?: GitPullRequestStack
  updatedAt?: string
}

export interface GitRepositoryState {
  root: string
  branch: string
  head: string
  upstream?: string
  ahead: number
  behind: number
  files: GitChangedFile[]
  pullRequests: GitPullRequest[]
  updatedAt: string
  remoteUpdatedAt?: string
  error?: string
}

export interface GitBranchState {
  branch: string
  pullRequests: GitPullRequest[]
  updatedAt: string
  repository?: string
}

export interface GitSupportSnapshot {
  version: 1
  revision: number
  aliases: Record<string, string>
  repositories: Record<string, GitRepositoryState>
  updatedAt: string
}

export interface GitInspectOptions {
  includeRemote?: boolean
  force?: boolean
}

export interface GitBranchInspectOptions {
  repository?: string
  originUrl?: string
  force?: boolean
}

export interface GitSupportService {
  snapshot(): GitSupportSnapshot
  inspect(location: string, options?: GitInspectOptions): Promise<GitRepositoryState>
  inspectBranch(
    location: string,
    branch: string,
    options?: GitBranchInspectOptions,
  ): Promise<GitBranchState>
}

declare module 'cordis' {
  interface Context {
    gitSupport: GitSupportService
  }
}
