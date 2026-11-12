import type {
  CommitInfo,
  ReleaseInfo,
  RepoRef,
  RunInfo,
  TagInfo,
  WorkflowInfo,
} from '../core/types';

export type AuthStrategy = 'device-flow' | 'oauth-web' | 'pat';

export interface Credential {
  provider: string;
  token: string;
  strategy: AuthStrategy;
  login?: string;
  scopes: string[];
  obtainedAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult = {
  status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'ok';
  token?: string;
  scopes?: string[];
  message?: string;
};

export interface AuthContext {
  relayUrl?: string;
  scopes: string;
}

export interface WebFlowContext extends AuthContext {
  redirectUri: string;
  state: string;
  code?: string;
}

export interface ViewerInfo {
  login: string;
  scopes: string[];
  avatarUrl?: string;
}

export interface RepositoryMeta {
  defaultBranch: string;
  htmlUrl: string;
  description: string;
  private: boolean;
}

export interface GitProviderClient {
  readonly id: string;
  viewer(): Promise<ViewerInfo>;
  repository(ref: RepoRef): Promise<RepositoryMeta>;
  listBranches(ref: RepoRef): Promise<string[]>;
  workflow(ref: RepoRef, file: string): Promise<WorkflowInfo | null>;
  listWorkflows(ref: RepoRef): Promise<WorkflowInfo[]>;
  dispatchWorkflow(
    ref: RepoRef,
    file: string,
    opts: { ref: string; inputs?: Record<string, string> },
  ): Promise<{ runId?: string }>;
  latestRunId(ref: RepoRef, file: string): Promise<string | null>;
  latestRun(ref: RepoRef, opts?: { branch?: string; file?: string }): Promise<RunInfo | null>;
  run(ref: RepoRef, runId: string): Promise<RunInfo>;
  latestRelease(ref: RepoRef): Promise<ReleaseInfo | null>;
  tags(ref: RepoRef): Promise<TagInfo[]>;
  commits(
    ref: RepoRef,
    opts: { since?: string; branch?: string; limit?: number },
  ): Promise<CommitInfo[]>;
  createTag(ref: RepoRef, tag: string, sha: string, message?: string): Promise<void>;
  createRelease(
    ref: RepoRef,
    input: { tag: string; name: string; body: string; draft: boolean; prerelease: boolean },
  ): Promise<ReleaseInfo>;
}

export interface AuthProvider {
  strategies: AuthStrategy[];
  deviceFlow?: {
    start(ctx: AuthContext): Promise<DeviceCode>;
    poll(ctx: AuthContext, deviceCode: string): Promise<DevicePollResult>;
  };
  webFlow?: {
    authorizeUrl(ctx: WebFlowContext): string;
    exchange(ctx: WebFlowContext): Promise<{ token: string; scopes: string[] }>;
  };
  pat?: {
    placeholder: string;
    hint: string;
  };
}

export interface GitProviderPlugin {
  id: string;
  label: string;
  description: string;
  accent: string;
  requiresAuth: boolean;
  auth: AuthProvider | null;
  createClient(credential: Credential, options?: { apiBase?: string }): GitProviderClient;
  repoUrl?(ref: RepoRef): string;
}
