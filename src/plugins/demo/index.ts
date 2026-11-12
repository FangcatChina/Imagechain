import type {
  CommitInfo,
  ReleaseInfo,
  RepoRef,
  RunInfo,
  TagInfo,
  WorkflowInfo,
} from '../../core/types';
import type {
  GitProviderClient,
  GitProviderPlugin,
  RepositoryMeta,
  ViewerInfo,
} from '../types';

interface DemoRunRecord {
  id: string;
  file: string;
  createdAt: number;
  duration: number;
  headSha: string;
  failure: boolean;
}

interface DemoRepoState {
  runs: Map<string, DemoRunRecord[]>;
  releases: ReleaseInfo[];
  tags: TagInfo[];
}

const DAY = 86400000;
const state = new Map<string, DemoRepoState>();
let runCounter = 4800;

const TITLES = [
  'feat: add multi-arch build matrix',
  'fix: correct image tag casing',
  'chore: bump base image to 24.04',
  'perf: cut image size by 18% with fewer layers',
  'ci: cache registry login between jobs',
  'docs: document rollback procedure',
  'test: add healthcheck smoke test',
  'refactor: split Dockerfile into stages',
  'fix: pin buildah to a known good version',
  'feat: sign images with cosign',
];

const AUTHORS = ['lwei', 'zmchen', 'haoc', 'wfang', 'dependabot[bot]'];

const idOf = (ref: RepoRef): string => `${ref.owner}/${ref.name}`;

function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function fakeSha(seed: number): string {
  let value = seed >>> 0;
  let out = '';
  for (let i = 0; i < 40; i += 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    out += '0123456789abcdef'[value % 16];
  }
  return out;
}

function ensureState(ref: RepoRef): DemoRepoState {
  const id = idOf(ref);
  let entry = state.get(id);
  if (!entry) {
    const head = fakeSha(hash(id));
    entry = {
      runs: new Map(),
      releases: [
        {
          tag: 'v2026.10.28.01',
          name: 'v2026.10.28.01',
          url: `https://github.com/${id}/releases/tag/v2026.10.28.01`,
          publishedAt: new Date(Date.now() - 14 * DAY).toISOString(),
          draft: false,
          prerelease: false,
          body: 'Previous automated release.',
        },
      ],
      tags: [{ name: 'v2026.10.28.01', sha: head }],
    };
    state.set(id, entry);
  }
  return entry;
}

function derive(record: DemoRunRecord): { status: string; conclusion: string | null } {
  const elapsed = Date.now() - record.createdAt;
  if (elapsed < 1500) return { status: 'queued', conclusion: null };
  if (elapsed < record.duration) return { status: 'in_progress', conclusion: null };
  return { status: 'completed', conclusion: record.failure ? 'failure' : 'success' };
}

function toRunInfo(record: DemoRunRecord): RunInfo {
  const derived = derive(record);
  return {
    id: record.id,
    status: derived.status,
    conclusion: derived.conclusion,
    htmlUrl: `https://github.com/demo/imagechain/actions/runs/${record.id}`,
    headSha: record.headSha,
    createdAt: new Date(record.createdAt).toISOString(),
    title: `Build ${record.file}`,
  };
}

class DemoClient implements GitProviderClient {
  readonly id = 'demo';

  async viewer(): Promise<ViewerInfo> {
    return { login: 'demo-user', scopes: ['demo'] };
  }

  async repository(ref: RepoRef): Promise<RepositoryMeta> {
    const id = idOf(ref);
    return {
      defaultBranch: 'main',
      htmlUrl: `https://github.com/${id}`,
      description: `${ref.name} demo repository`,
      private: false,
    };
  }

  async listBranches(): Promise<string[]> {
    return ['main', 'release', 'develop'];
  }

  async workflow(ref: RepoRef, file: string): Promise<WorkflowInfo> {
    return {
      id: `demo-${file}`,
      name: file.replace(/\.ya?ml$/, ''),
      file,
      path: `.github/workflows/${file}`,
      htmlUrl: `https://github.com/${idOf(ref)}/actions/workflows/${file}`,
    };
  }

  async listWorkflows(ref: RepoRef): Promise<WorkflowInfo[]> {
    const entry = ensureState(ref);
    const files = new Set<string>(entry.runs.keys());
    if (!files.size) files.add('build-image.yml');
    return [...files].map((file) => ({
      id: `demo-${file}`,
      name: file.replace(/\.ya?ml$/, ''),
      file,
      path: `.github/workflows/${file}`,
      htmlUrl: `https://github.com/${idOf(ref)}/actions/workflows/${file}`,
    }));
  }

  async dispatchWorkflow(
    ref: RepoRef,
    file: string,
    opts: { ref: string; inputs?: Record<string, string> },
  ): Promise<{ runId?: string }> {
    const entry = ensureState(ref);
    runCounter += 1;
    const seed = hash(`${idOf(ref)}:${file}:${runCounter}`);
    const record: DemoRunRecord = {
      id: String(100000 + runCounter),
      file,
      createdAt: Date.now(),
      duration: 4000 + (seed % 5000),
      headSha: fakeSha(seed + opts.ref.length),
      failure: /flaky/i.test(ref.name),
    };
    const list = entry.runs.get(file) ?? [];
    list.push(record);
    entry.runs.set(file, list);
    return { runId: record.id };
  }

  async latestRunId(ref: RepoRef, file: string): Promise<string | null> {
    const entry = ensureState(ref);
    let list = entry.runs.get(file);
    if (!list) {
      list = [];
      entry.runs.set(file, list);
    }
    if (!list.length) {
      runCounter += 1;
      list.push({
        id: String(90000 + runCounter),
        file,
        createdAt: Date.now() - 2 * DAY,
        duration: 1,
        headSha: fakeSha(hash(`${idOf(ref)}:${file}:seed`)),
        failure: false,
      });
    }
    return list[list.length - 1].id;
  }

  async latestRun(ref: RepoRef, opts: { branch?: string; file?: string } = {}): Promise<RunInfo | null> {
    const entry = ensureState(ref);
    const files = opts.file
      ? [opts.file]
      : (await this.listWorkflows(ref)).map((item) => item.file);
    for (const file of files) {
      await this.latestRunId(ref, file);
    }
    let latest: DemoRunRecord | null = null;
    for (const list of entry.runs.values()) {
      for (const record of list) {
        if (opts.file && record.file !== opts.file) continue;
        if (!latest || record.createdAt > latest.createdAt) latest = record;
      }
    }
    return latest ? toRunInfo(latest) : null;
  }

  async run(ref: RepoRef, runId: string): Promise<RunInfo> {
    const entry = ensureState(ref);
    for (const list of entry.runs.values()) {
      const found = list.find((record) => record.id === runId);
      if (found) return toRunInfo(found);
    }
    throw new Error(`Unknown demo run ${runId}`);
  }

  async latestRelease(ref: RepoRef): Promise<ReleaseInfo | null> {
    const releases = ensureState(ref).releases;
    return releases.length ? releases[releases.length - 1] : null;
  }

  async tags(ref: RepoRef): Promise<TagInfo[]> {
    return [...ensureState(ref).tags];
  }

  async commits(
    ref: RepoRef,
    opts: { since?: string; branch?: string; limit?: number },
  ): Promise<CommitInfo[]> {
    const id = idOf(ref);
    const seed = hash(id);
    const since = opts.since ? Date.parse(opts.since) : 0;
    const out: CommitInfo[] = [];
    for (let i = 0; i < (opts.limit ?? 30); i += 1) {
      const at = Date.now() - (i + 1) * 2 * DAY - (seed % 6) * 3600000;
      if (since && at < since) break;
      const title = TITLES[(seed + i * 3) % TITLES.length];
      const sha = fakeSha(seed + i);
      out.push({
        sha,
        shortSha: sha.slice(0, 7),
        title,
        message: title,
        author: AUTHORS[(seed + i) % AUTHORS.length],
        date: new Date(at).toISOString(),
        url: `https://github.com/${id}/commit/${sha}`,
      });
    }
    return out;
  }

  async createTag(ref: RepoRef, tag: string, sha: string): Promise<void> {
    const entry = ensureState(ref);
    entry.tags.push({ name: tag, sha });
  }

  async createRelease(
    ref: RepoRef,
    input: { tag: string; name: string; body: string; draft: boolean; prerelease: boolean },
  ): Promise<ReleaseInfo> {
    const entry = ensureState(ref);
    const release: ReleaseInfo = {
      tag: input.tag,
      name: input.name,
      url: `https://github.com/${idOf(ref)}/releases/tag/${input.tag}`,
      publishedAt: new Date().toISOString(),
      draft: input.draft,
      prerelease: input.prerelease,
      body: input.body,
    };
    entry.releases.push(release);
    return release;
  }
}

export const demoPlugin: GitProviderPlugin = {
  id: 'demo',
  label: 'Demo data',
  description: 'Simulated provider: no token, fake runs, releases and commits.',
  accent: '#22d3ee',
  requiresAuth: false,
  auth: null,
  createClient: () => new DemoClient(),
  repoUrl: (ref) => `https://github.com/${ref.owner}/${ref.name}`,
};
