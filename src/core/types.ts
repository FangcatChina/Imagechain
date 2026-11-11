export type ProviderId = string;

export type BuildStatus =
  | 'idle'
  | 'waiting'
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'cancelled';

export const statusText: Record<BuildStatus, string> = {
  idle: 'No runs',
  waiting: 'Waiting',
  queued: 'Queued',
  running: 'Building',
  success: 'Success',
  failure: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

export interface RepoRef {
  owner: string;
  name: string;
}

export interface WorkflowSpec {
  file: string;
  ref?: string;
  inputs?: Record<string, string>;
  optional?: boolean;
}

export interface RepoNode {
  key: string;
  provider: ProviderId;
  repo: RepoRef;
  url: string;
  description: string;
  branch: string;
  dependsOn: string[];
  workflows: WorkflowSpec[];
  labels: string[];
}

export interface ChainConfig {
  version: number;
  provider: ProviderId;
  branch: string;
  concurrency: number;
  repos: RepoNode[];
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  url: string;
  publishedAt: string;
  draft: boolean;
  prerelease: boolean;
  body?: string;
}

export interface TagInfo {
  name: string;
  sha: string;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  file: string;
  path?: string;
  htmlUrl: string;
}

export interface RunInfo {
  id: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
  createdAt: string;
  title?: string;
}

export interface WorkflowRunRecord {
  file: string;
  runId: string;
  htmlUrl: string;
  status: string;
  conclusion: string | null;
}

export interface RunStep {
  repoKey: string;
  status: BuildStatus;
  startedAt?: number;
  finishedAt?: number;
  runs: WorkflowRunRecord[];
  error?: string;
}

export interface PlanState {
  id: string;
  status: 'running' | 'success' | 'failure' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  levels: string[][];
  steps: Record<string, RunStep>;
}

export interface RepoBaseline {
  build: BuildStatus;
  lastRun?: RunInfo;
  tag?: string;
  fetchedAt: number;
}

export const repoFullName = (ref: RepoRef): string => `${ref.owner}/${ref.name}`;
