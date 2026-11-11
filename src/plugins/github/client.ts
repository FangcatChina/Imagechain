import type {
  CommitInfo,
  ReleaseInfo,
  RepoRef,
  RunInfo,
  TagInfo,
  WorkflowInfo,
} from '../../core/types';
import type { GitProviderClient, RepositoryMeta, ViewerInfo } from '../types';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function baseHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const repoPath = (ref: RepoRef): string =>
  `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

export class GitHubClient implements GitProviderClient {
  readonly id = 'github';

  constructor(
    private readonly token: string,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...baseHeaders(this.token),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const res = await fetch(`${this.apiBase}${path}`, { ...init, headers });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAt = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      const rateHint =
        remaining === '0'
          ? ` (rate limit exhausted, resets at ${new Date(resetAt).toLocaleTimeString()})`
          : '';
      const message = (data as { message?: string } | null)?.message ?? res.statusText;
      throw new GitHubApiError(res.status, `${res.status} ${message}${rateHint}`, path);
    }
    return data as T;
  }

  async viewer(): Promise<ViewerInfo> {
    const res = await fetch(`${this.apiBase}/user`, { headers: baseHeaders(this.token) });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `${res.status} cannot read /user`, '/user');
    }
    const data = (await res.json()) as { login: string; avatar_url?: string };
    const scopes = (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
    return { login: data.login, scopes, avatarUrl: data.avatar_url };
  }

  async repository(ref: RepoRef): Promise<RepositoryMeta> {
    const data = await this.request<{
      default_branch: string;
      html_url: string;
      description: string | null;
      private: boolean;
    }>(repoPath(ref));
    return {
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      description: data.description ?? '',
      private: data.private,
    };
  }

  async listBranches(ref: RepoRef): Promise<string[]> {
    const data = await this.request<Array<{ name: string }>>(`${repoPath(ref)}/branches?per_page=100`);
    return data.map((branch) => branch.name);
  }

  async workflow(ref: RepoRef, file: string): Promise<WorkflowInfo | null> {
    return this.resolveWorkflow(ref, file);
  }

  private async resolveWorkflow(ref: RepoRef, file: string): Promise<WorkflowInfo | null> {
    try {
      const data = await this.request<{
        id: number;
        name: string;
        path: string;
        html_url: string;
      }>(`${repoPath(ref)}/actions/workflows/${encodeURIComponent(file)}`);
      return this.mapWorkflow(data);
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
    }
    const all = await this.listWorkflows(ref).catch(() => [] as WorkflowInfo[]);
    return (
      all.find(
        (item) =>
          item.name === file ||
          item.path === file ||
          item.file === file ||
          item.path?.endsWith(`/${file}`),
      ) ?? null
    );
  }

  private mapWorkflow(data: {
    id: number;
    name: string;
    path: string;
    html_url: string;
  }): WorkflowInfo {
    return {
      id: String(data.id),
      name: data.name,
      file: data.path.split('/').pop() ?? data.path,
      path: data.path,
      htmlUrl: data.html_url,
    };
  }

  async listWorkflows(ref: RepoRef): Promise<WorkflowInfo[]> {
    const data = await this.request<{
      workflows: Array<{ id: number; name: string; path: string; html_url: string }>;
    }>(`${repoPath(ref)}/actions/workflows?per_page=100`);
    return data.workflows.map((item) => this.mapWorkflow(item));
  }

  async dispatchWorkflow(
    ref: RepoRef,
    file: string,
    opts: { ref: string; inputs?: Record<string, string> },
  ): Promise<{ runId?: string }> {
    let resolved: WorkflowInfo | null = null;
    try {
      resolved = await this.resolveWorkflow(ref, file);
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
    }

    if (!resolved) {
      const repo = await this.repository(ref).then(
        () => true,
        (err) => !(err instanceof GitHubApiError && err.status === 404),
      );
      if (!repo) {
        throw new Error(
          `Repository ${ref.owner}/${ref.name} was not found or is not accessible with the current token.`,
        );
      }
      throw new Error(
        `No workflow named "${file}" in ${ref.owner}/${ref.name}. ` +
          'workflow_dispatch requires the workflow file to exist on the default branch with an on: workflow_dispatch trigger.',
      );
    }

    const inputs = opts.inputs
      ? Object.fromEntries(Object.entries(opts.inputs).map(([key, value]) => [key, String(value)]))
      : {};

    try {
      const data = await this.request<{ workflow_run_id?: number }>(
        `${repoPath(ref)}/actions/workflows/${encodeURIComponent(resolved.id)}/dispatches`,
        {
          method: 'POST',
          body: JSON.stringify({ ref: opts.ref, inputs }),
        },
      );
      return { runId: data?.workflow_run_id ? String(data.workflow_run_id) : undefined };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        throw new Error(
          `GitHub returned 404 for "${resolved.name}" (${resolved.path}). ` +
            `workflow_dispatch only works when the workflow exists on the default branch; ` +
            `ref "${opts.ref}" must also exist. Token needs repo + workflow (actions: write).`,
        );
      }
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new Error(
          `GitHub rejected the dispatch for "${resolved.name}": the workflow has no workflow_dispatch trigger, ` +
            `or ref "${opts.ref}" does not exist, or an input is invalid.`,
        );
      }
      throw err;
    }
  }

  async latestRunId(ref: RepoRef, file: string): Promise<string | null> {
    let target = file;
    try {
      const resolved = await this.resolveWorkflow(ref, file);
      if (!resolved) return null;
      target = resolved.id;
    } catch {
      return null;
    }
    try {
      const data = await this.request<{ workflow_runs: Array<{ id: number }> }>(
        `${repoPath(ref)}/actions/workflows/${encodeURIComponent(target)}/runs?per_page=1`,
      );
      return data.workflow_runs[0] ? String(data.workflow_runs[0].id) : null;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async run(ref: RepoRef, runId: string): Promise<RunInfo> {
    const data = await this.request<{
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      head_sha: string;
      created_at: string;
      display_title?: string;
    }>(`${repoPath(ref)}/actions/runs/${encodeURIComponent(runId)}`);
    return {
      id: String(data.id),
      status: data.status,
      conclusion: data.conclusion ?? null,
      htmlUrl: data.html_url,
      headSha: data.head_sha,
      createdAt: data.created_at,
      title: data.display_title,
    };
  }

  async latestRelease(ref: RepoRef): Promise<ReleaseInfo | null> {
    try {
      const data = await this.request<{
        tag_name: string;
        name: string | null;
        html_url: string;
        published_at: string;
        draft: boolean;
        prerelease: boolean;
        body: string | null;
      }>(`${repoPath(ref)}/releases/latest`);
      return {
        tag: data.tag_name,
        name: data.name ?? data.tag_name,
        url: data.html_url,
        publishedAt: data.published_at,
        draft: data.draft,
        prerelease: data.prerelease,
        body: data.body ?? '',
      };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async tags(ref: RepoRef): Promise<TagInfo[]> {
    const data = await this.request<Array<{ name: string; commit: { sha: string } }>>(
      `${repoPath(ref)}/tags?per_page=100`,
    );
    return data.map((tag) => ({ name: tag.name, sha: tag.commit.sha }));
  }

  async commits(
    ref: RepoRef,
    opts: { since?: string; branch?: string; limit?: number },
  ): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ per_page: String(opts.limit ?? 30) });
    if (opts.since) params.set('since', opts.since);
    if (opts.branch) params.set('sha', opts.branch);
    const data = await this.request<
      Array<{
        sha: string;
        html_url: string;
        commit: { message: string; author: { name: string; date: string } | null };
        author: { login: string } | null;
      }>
    >(`${repoPath(ref)}/commits?${params.toString()}`);
    return data.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      title: (commit.commit.message ?? '').split('\n')[0],
      message: commit.commit.message ?? '',
      author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
      date: commit.commit.author?.date ?? '',
      url: commit.html_url,
    }));
  }

  async createTag(ref: RepoRef, tag: string, sha: string, _message?: string): Promise<void> {
    await this.request(`${repoPath(ref)}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
    });
  }

  async createRelease(
    ref: RepoRef,
    input: { tag: string; name: string; body: string; draft: boolean; prerelease: boolean },
  ): Promise<ReleaseInfo> {
    const data = await this.request<{
      tag_name: string;
      name: string | null;
      html_url: string;
      published_at: string | null;
      draft: boolean;
      prerelease: boolean;
      body: string | null;
    }>(`${repoPath(ref)}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: input.tag,
        name: input.name,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease,
      }),
    });
    return {
      tag: data.tag_name,
      name: data.name ?? data.tag_name,
      url: data.html_url,
      publishedAt: data.published_at ?? new Date().toISOString(),
      draft: data.draft,
      prerelease: data.prerelease,
      body: data.body ?? '',
    };
  }
}
