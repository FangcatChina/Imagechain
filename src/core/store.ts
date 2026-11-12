import { create } from 'zustand';
import { parse, stringify } from 'yaml';
import SAMPLE_CONFIG from '../../examples/imagechain.yaml?raw';
import { parseConfig } from './config';
import { withDescendants } from './graph';
import { PlanRunner } from './scheduler';
import type { LogLevel } from './scheduler';
import type {
  ChainConfig,
  CommitInfo,
  PlanState,
  ReleaseInfo,
  RepoBaseline,
  RepoNode,
  RunInfo,
  TagInfo,
  WorkflowInfo,
  WorkflowSpec,
} from './types';
import { getPlugin } from '../plugins/registry';
import type { Credential, GitProviderClient } from '../plugins/types';

const CONFIG_KEY = 'imagechain:config';
const PROVIDER_KEY = 'imagechain:provider';
const CREDENTIALS_KEY = 'imagechain:credentials';
const SETTINGS_KEY = 'imagechain:settings';

export interface AuthSettings {
  relayUrl: string;
  apiBase: string;
  scopes: string;
  pollIntervalMs: number;
}

export const defaultSettings: AuthSettings = {
  relayUrl: '',
  apiBase: 'https://api.github.com',
  scopes: 'repo workflow read:user',
  pollIntervalMs: 10000,
};

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  message: string;
}

export interface WorkflowDetail {
  spec: WorkflowSpec;
  info: WorkflowInfo | null;
  latestRun: RunInfo | null;
}

export interface BatchResult {
  key: string;
  ok: boolean;
  error?: string;
}

export interface RepoDetail {
  loading: boolean;
  error?: string;
  fetchedAt?: number;
  meta?: { defaultBranch: string; htmlUrl: string; description: string; private: boolean };
  latestRelease?: ReleaseInfo | null;
  tags?: TagInfo[];
  workflows?: WorkflowDetail[];
  commits?: CommitInfo[];
}

export interface AppStore {
  configText: string;
  config: ChainConfig | null;
  configErrors: string[];
  providerId: string;
  credentials: Record<string, Credential>;
  settings: AuthSettings;
  plan: PlanState | null;
  baseline: Record<string, RepoBaseline>;
  baselineLoading: boolean;
  availableWorkflows: Record<string, WorkflowInfo[]>;
  running: boolean;
  logs: LogEntry[];
  selected: string | null;
  details: Record<string, RepoDetail>;

  setConfigText: (text: string) => void;
  applyConfig: () => boolean;
  importConfig: (text: string) => boolean;
  setProvider: (id: string) => void;
  setSettings: (patch: Partial<AuthSettings>) => void;
  setCredential: (credential: Credential | null) => void;
  select: (key: string | null) => void;
  refreshDetail: (key: string) => Promise<void>;
  loadBaseline: () => Promise<void>;
  loadWorkflows: (key: string) => Promise<void>;
  pushTag: (key: string, tag: string) => Promise<{ ok: boolean; error?: string }>;
  publishRelease: (
    key: string,
    input: { tag: string; title: string; notes?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  pushTagBatch: (keys: string[], tag: string) => Promise<BatchResult[]>;
  publishReleaseBatch: (
    keys: string[],
    input: { tag: string; title: string },
  ) => Promise<BatchResult[]>;
  upsertRepo: (node: RepoNode, originalKey?: string) => boolean;
  removeRepo: (key: string) => boolean;
  resetConfig: () => void;
  startPlan: (keys?: string[]) => Promise<{ ok: boolean; error?: string }>;
  cancelPlan: () => void;
  clearLogs: () => void;
  log: (message: string, level?: LogLevel) => void;
}

function readText(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return;
  }
}

function emptyCredential(provider: string): Credential {
  return {
    provider,
    token: '',
    strategy: 'pat',
    scopes: [],
    obtainedAt: Date.now(),
  };
}

async function loadDetail(client: GitProviderClient, repo: RepoNode): Promise<RepoDetail> {
  const [meta, release, tags] = await Promise.all([
    client.repository(repo.repo),
    client.latestRelease(repo.repo),
    client.tags(repo.repo),
  ]);

  const workflows = await Promise.all(
    repo.workflows.map(async (spec) => {
      const [info, latestRun] = await Promise.all([
        client.workflow(repo.repo, spec.file).catch(() => null),
        client.latestRun(repo.repo, { file: spec.file }).catch(() => null),
      ]);
      return { spec, info, latestRun };
    }),
  );

  const commits = await client
    .commits(repo.repo, { since: release?.publishedAt, branch: repo.branch, limit: 30 })
    .catch(() => [] as CommitInfo[]);

  return {
    loading: false,
    fetchedAt: Date.now(),
    meta,
    latestRelease: release,
    tags,
    workflows,
    commits,
  };
}

const initialText = readText(CONFIG_KEY, SAMPLE_CONFIG);
const initialParse = parseConfig(initialText);
const initialProvider = readText(PROVIDER_KEY, 'demo');

async function loadBaselineFor(client: GitProviderClient, repo: RepoNode): Promise<RepoBaseline> {
  const lastRun = await client.latestRun(repo.repo).catch(() => null);

  let build: RepoBaseline['build'] = 'idle';
  if (lastRun) {
    if (['in_progress', 'waiting', 'requested', 'pending'].includes(lastRun.status)) {
      build = 'running';
    } else if (lastRun.status === 'queued') {
      build = 'queued';
    } else if (lastRun.status === 'completed') {
      build = ['success', 'skipped', 'neutral'].includes(lastRun.conclusion ?? '')
        ? 'success'
        : 'failure';
    }
  }

  const release = await client.latestRelease(repo.repo).catch(() => null);
  const tag = release?.tag ?? (await client.tags(repo.repo).catch(() => [] as TagInfo[]))[0]?.name;

  return { build, lastRun: lastRun ?? undefined, tag, fetchedAt: Date.now() };
}

function renderNotes(tag: string, commits: CommitInfo[], previousTag: string | null): string {
  const lines = [`Tag: \`${tag}\``, '', `### Changes (${commits.length})`];
  if (!commits.length) lines.push('_No new commits since the previous release._');
  for (const commit of commits) {
    lines.push(`- ${commit.title} — @${commit.author} (${commit.shortSha})`);
  }
  if (previousTag) lines.push('', `Compare: ${previousTag} → ${tag}`);
  return lines.join('\n');
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next);
    }
  });
  await Promise.all(workers);
}

function entryKey(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const entry = item as Record<string, unknown>;
  const slug = String(entry.repo ?? entry.name ?? '');
  return String(entry.key ?? slug.split('/')[1] ?? '');
}

function toYamlRepo(node: RepoNode): Record<string, unknown> {
  return {
    key: node.key,
    repo: `${node.repo.owner}/${node.repo.name}`,
    description: node.description || undefined,
    branch: node.branch,
    dependsOn: node.dependsOn,
    workflows: node.workflows.map((workflow) => ({
      file: workflow.file,
      ...(workflow.ref ? { ref: workflow.ref } : {}),
      ...(workflow.inputs ? { inputs: workflow.inputs } : {}),
      ...(workflow.optional ? { optional: true } : {}),
    })),
  };
}

function renameDependency(doc: Record<string, unknown>, from: string, to: string): void {
  const repos = doc.repos;
  const entries = Array.isArray(repos) ? repos : repos && typeof repos === 'object' ? Object.values(repos) : [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (Array.isArray(entry.dependsOn)) {
      entry.dependsOn = (entry.dependsOn as unknown[]).map((dep) => (String(dep) === from ? to : dep));
    }
  }
}

function stripDependency(doc: Record<string, unknown>, key: string): void {
  const repos = doc.repos;
  const entries = Array.isArray(repos) ? repos : repos && typeof repos === 'object' ? Object.values(repos) : [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (Array.isArray(entry.dependsOn)) {
      entry.dependsOn = (entry.dependsOn as unknown[])
        .map((dep) => String(dep))
        .filter((dep) => dep !== key);
    }
  }
}

let controller: AbortController | null = null;

export const useApp = create<AppStore>()((set, get) => {
  const log = (message: string, level: LogLevel = 'info') => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      level,
      message,
    };
    set((state) => ({ logs: [...state.logs.slice(-499), entry] }));
  };

  const buildClient = (): GitProviderClient => {
    const state = get();
    const plugin = getPlugin(state.providerId);
    const credential = state.credentials[state.providerId] ?? emptyCredential(plugin.id);
    if (plugin.requiresAuth && !state.credentials[state.providerId]) {
      throw new Error('Not signed in to the active Git provider');
    }
    return plugin.createClient(credential, { apiBase: state.settings.apiBase });
  };

  const commitDoc = (doc: unknown, selectedKey: string | null): boolean => {
    set({ configText: stringify(doc) });
    const ok = get().applyConfig();
    if (ok && selectedKey && get().config?.repos.some((repo) => repo.key === selectedKey)) {
      set({ selected: selectedKey });
      void get().refreshDetail(selectedKey);
    }
    return ok;
  };

  const tagOnce = async (key: string, rawTag: string): Promise<{ ok: boolean; error?: string }> => {
    const state = get();
    const repo = state.config?.repos.find((item) => item.key === key);
    if (!repo) return { ok: false, error: `Unknown repository ${key}` };
    const name = rawTag.trim();
    if (!name) return { ok: false, error: 'Tag name is required' };

    try {
      const client = buildClient();
      let sha = state.baseline[key]?.lastRun?.headSha;
      if (!sha) {
        const head = await client.commits(repo.repo, { branch: repo.branch, limit: 1 });
        sha = head[0]?.sha ?? '';
      }
      if (!sha) throw new Error('No commit available to tag');

      await client.createTag(repo.repo, name, sha);
      log(`Tagged ${key} as ${name}`, 'ok');
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      log(`Tag failed for ${key}: ${message}`, 'error');
      return { ok: false, error: message };
    }
  };

  const releaseOnce = async (
    key: string,
    input: { tag: string; title: string; notes?: string },
  ): Promise<{ ok: boolean; error?: string }> => {
    const state = get();
    const repo = state.config?.repos.find((item) => item.key === key);
    if (!repo) return { ok: false, error: `Unknown repository ${key}` };
    const tag = input.tag.trim();
    if (!tag) return { ok: false, error: 'Tag is required' };

    try {
      const client = buildClient();
      const previous = await client.latestRelease(repo.repo);
      const commits = await client.commits(repo.repo, {
        since: previous?.publishedAt,
        branch: repo.branch,
        limit: 50,
      });
      const body = input.notes?.trim()
        ? input.notes
        : renderNotes(tag, commits, previous?.tag ?? null);

      await client.createRelease(repo.repo, {
        tag,
        name: input.title.trim() || tag,
        body,
        draft: false,
        prerelease: false,
      });
      log(`Published release ${input.title.trim() || tag} (${tag}) on ${key}`, 'ok');
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      log(`Release failed for ${key}: ${message}`, 'error');
      return { ok: false, error: message };
    }
  };

  return {
    configText: initialText,
    config: initialParse.config,
    configErrors: initialParse.errors,
    providerId: initialProvider,
    credentials: readJson<Record<string, Credential>>(CREDENTIALS_KEY, {}),
    settings: {
      ...defaultSettings,
      relayUrl: (import.meta.env.VITE_OAUTH_RELAY as string | undefined) ?? '',
      ...readJson<Partial<AuthSettings>>(SETTINGS_KEY, {}),
    },
    plan: null,
    baseline: {},
    baselineLoading: false,
    availableWorkflows: {},
    running: false,
    logs: [],
    selected: null,
    details: {},

    setConfigText: (text) => set({ configText: text }),

    applyConfig: () => {
      const result = parseConfig(get().configText);
      set({ config: result.config, configErrors: result.errors });
      if (result.config) {
        write(CONFIG_KEY, get().configText);
        set({ details: {}, plan: null, selected: null });
        log('Configuration applied', 'ok');
        void get().loadBaseline();
      } else {
        log('Configuration rejected: ' + result.errors.join('; '), 'error');
      }
      return result.errors.length === 0;
    },

    importConfig: (text) => {
      set({ configText: text });
      return get().applyConfig();
    },

    setProvider: (id) => {
      write(PROVIDER_KEY, id);
      set({ providerId: id, details: {}, selected: null, baseline: {}, availableWorkflows: {} });
      log(`Active provider: ${id}`, 'info');
      void get().loadBaseline();
    },

    setSettings: (patch) => {
      const settings = { ...get().settings, ...patch };
      write(SETTINGS_KEY, settings);
      set({ settings });
    },

    setCredential: (credential) => {
      const providerId = get().providerId;
      const credentials = { ...get().credentials };
      if (credential) credentials[providerId] = credential;
      else delete credentials[providerId];
      write(CREDENTIALS_KEY, credentials);
      set({ credentials, details: {} });
      void get().loadBaseline();
    },

    select: (key) => {
      set({ selected: key });
      if (key && !get().details[key]) {
        void get().refreshDetail(key);
      }
    },

    loadBaseline: async () => {
      const state = get();
      const config = state.config;
      const plugin = getPlugin(state.providerId);
      const credential = state.credentials[state.providerId];

      if (!config) {
        set({ baseline: {}, baselineLoading: false });
        return;
      }
      if (plugin.requiresAuth && !credential) {
        set({ baseline: {}, baselineLoading: false });
        return;
      }

      set({ baselineLoading: true });
      try {
        const client = plugin.createClient(credential ?? emptyCredential(plugin.id), {
          apiBase: state.settings.apiBase,
        });
        const result: Record<string, RepoBaseline> = {};
        await runLimited(config.repos, 4, async (repo) => {
          result[repo.key] = await loadBaselineFor(client, repo).catch(() => ({
            build: 'idle' as const,
            fetchedAt: Date.now(),
          }));
        });
        set({ baseline: result, baselineLoading: false });
      } catch (err) {
        set({ baselineLoading: false });
        log(`Could not load last build state: ${(err as Error).message}`, 'warn');
      }
    },

    loadWorkflows: async (key) => {
      const repo = get().config?.repos.find((item) => item.key === key);
      if (!repo) return;
      try {
        const workflows = await buildClient().listWorkflows(repo.repo);
        set((state) => ({ availableWorkflows: { ...state.availableWorkflows, [key]: workflows } }));
      } catch (err) {
        log(`Could not list workflows for ${key}: ${(err as Error).message}`, 'warn');
      }
    },

    refreshDetail: async (key) => {
      const repo = get().config?.repos.find((item) => item.key === key);
      if (!repo) return;
      set((state) => ({
        details: { ...state.details, [key]: { ...(state.details[key] ?? {}), loading: true, error: undefined } },
      }));
      try {
        const client = buildClient();
        const detail = await loadDetail(client, repo);
        set((state) => ({ details: { ...state.details, [key]: detail } }));
      } catch (err) {
        set((state) => ({
          details: {
            ...state.details,
            [key]: { loading: false, error: (err as Error).message },
          },
        }));
      }
    },

    pushTag: async (key, tag) => {
      const result = await tagOnce(key, tag);
      if (result.ok) {
        await get().loadBaseline();
        if (get().selected === key) void get().refreshDetail(key);
      }
      return result;
    },

    publishRelease: async (key, input) => {
      const result = await releaseOnce(key, input);
      if (result.ok) {
        await get().loadBaseline();
        if (get().selected === key) void get().refreshDetail(key);
      }
      return result;
    },

    pushTagBatch: async (keys, tag) => {
      const results: BatchResult[] = [];
      for (const key of keys) {
        results.push({ key, ...(await tagOnce(key, tag)) });
      }
      await get().loadBaseline();
      const selected = get().selected;
      if (selected) void get().refreshDetail(selected);
      return results;
    },

    publishReleaseBatch: async (keys, input) => {
      const results: BatchResult[] = [];
      for (const key of keys) {
        results.push({ key, ...(await releaseOnce(key, input)) });
      }
      await get().loadBaseline();
      const selected = get().selected;
      if (selected) void get().refreshDetail(selected);
      return results;
    },

    upsertRepo: (node, originalKey) => {
      let doc: unknown;
      try {
        doc = parse(get().configText);
      } catch (err) {
        log(`Cannot parse configuration: ${(err as Error).message}`, 'error');
        return false;
      }
      if (!doc || typeof doc !== 'object') return false;
      const root = doc as Record<string, unknown>;
      const yamlRepo = toYamlRepo(node);
      const matchKey = originalKey ?? node.key;
      const repos = root.repos;

      if (Array.isArray(repos)) {
        const index = repos.findIndex((item) => entryKey(item) === matchKey);
        if (index >= 0) repos[index] = yamlRepo;
        else repos.push(yamlRepo);
      } else if (repos && typeof repos === 'object') {
        const map = repos as Record<string, unknown>;
        if (matchKey !== node.key) delete map[matchKey];
        map[node.key] = yamlRepo;
      } else {
        root.repos = [yamlRepo];
      }

      if (originalKey && originalKey !== node.key) {
        renameDependency(root, originalKey, node.key);
      }
      return commitDoc(root, node.key);
    },

    removeRepo: (key) => {
      let doc: unknown;
      try {
        doc = parse(get().configText);
      } catch (err) {
        log(`Cannot parse configuration: ${(err as Error).message}`, 'error');
        return false;
      }
      if (!doc || typeof doc !== 'object') return false;
      const root = doc as Record<string, unknown>;
      const repos = root.repos;

      if (Array.isArray(repos)) {
        const index = repos.findIndex((item) => entryKey(item) === key);
        if (index < 0) return false;
        repos.splice(index, 1);
      } else if (repos && typeof repos === 'object') {
        delete (repos as Record<string, unknown>)[key];
      } else {
        return false;
      }

      stripDependency(root, key);
      const ok = commitDoc(root, null);
      if (ok) set({ selected: null });
      return ok;
    },

    resetConfig: () => {
      set({ configText: SAMPLE_CONFIG });
      get().applyConfig();
    },

    startPlan: async (keys) => {
      const state = get();
      if (state.running) return { ok: false, error: 'A plan is already running' };
      const config = state.config;
      if (!config) return { ok: false, error: 'Configuration is invalid' };

      const plugin = getPlugin(state.providerId);
      const credential = state.credentials[state.providerId];
      if (plugin.requiresAuth && !credential) {
        return { ok: false, error: 'Sign in to the active provider first' };
      }

      const repos = keys?.length ? withDescendants(config.repos, keys) : config.repos;
      controller = new AbortController();
      set({ running: true, logs: [], plan: null });

      const runner = new PlanRunner({
        config,
        only: keys?.length ? repos.map((repo) => repo.key) : undefined,
        clientFor: async () => buildClient(),
        concurrency: config.concurrency,
        pollIntervalMs: state.settings.pollIntervalMs,
        signal: controller.signal,
        onPlan: (plan) => set({ plan }),
        onLog: log,
      });

      try {
        const plan = await runner.run();
        set({ plan, running: false });
        const selected = get().selected;
        if (selected) void get().refreshDetail(selected);
        void get().loadBaseline();
        return {
          ok: plan.status === 'success',
          error: plan.status === 'success' ? undefined : `Plan finished with status ${plan.status}`,
        };
      } catch (err) {
        set({ running: false });
        log(`Plan failed to start: ${(err as Error).message}`, 'error');
        return { ok: false, error: (err as Error).message };
      } finally {
        controller = null;
      }
    },

    cancelPlan: () => {
      if (controller) {
        controller.abort();
        log('Cancellation requested', 'warn');
      }
    },

    clearLogs: () => set({ logs: [] }),

    log,
  };
});
