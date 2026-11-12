import { buildGraph } from './graph';
import type { ChainConfig, PlanState, RepoNode, RunStep, WorkflowSpec } from './types';
import type { GitProviderClient } from '../plugins/types';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

class AbortError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

export interface RunnerOptions {
  config: ChainConfig;
  clientFor: (repo: RepoNode) => Promise<GitProviderClient>;
  concurrency: number;
  signal: AbortSignal;
  onPlan: (plan: PlanState) => void;
  onLog: (message: string, level?: LogLevel) => void;
  /** Restrict the run to these repos; upstream repos outside the set count as ready. */
  only?: string[];
  pollIntervalMs?: number;
  dispatchTimeoutMs?: number;
  runTimeoutMs?: number;
}

export class PlanRunner {
  private plan: PlanState;
  private readonly pollInterval: number;
  private readonly dispatchTimeout: number;
  private readonly runTimeout: number;

  constructor(private readonly opts: RunnerOptions) {
    this.pollInterval = opts.pollIntervalMs ?? 10000;
    this.dispatchTimeout = opts.dispatchTimeoutMs ?? 120000;
    this.runTimeout = opts.runTimeoutMs ?? 45 * 60 * 1000;
    this.plan = {
      id: Date.now().toString(36),
      status: 'running',
      startedAt: Date.now(),
      levels: [],
      steps: {},
    };
  }

  async run(): Promise<PlanState> {
    const graph = buildGraph(this.opts.config.repos);
    if (graph.errors.length) throw new Error(graph.errors.join('; '));

    const only = this.opts.only?.length ? new Set(this.opts.only) : null;
    this.plan.levels = graph.levels
      .map((level) => level.filter((key) => !only || only.has(key)))
      .filter((level) => level.length > 0);
    for (const repo of this.opts.config.repos) {
      if (only && !only.has(repo.key)) continue;
      this.plan.steps[repo.key] = { repoKey: repo.key, status: 'idle', runs: [] };
    }
    this.emit();

    try {
      for (const level of this.plan.levels) {
        await this.runLevel(level);
        this.emit();
      }
      const failed = Object.values(this.plan.steps).some((step) => step.status !== 'success');
      this.plan.status = failed ? 'failure' : 'success';
    } catch (err) {
      if (err instanceof AbortError) {
        this.plan.status = 'cancelled';
      } else {
        this.plan.status = 'failure';
        this.opts.onLog(`Run aborted: ${(err as Error).message}`, 'error');
      }
    }

    this.plan.finishedAt = Date.now();
    this.emit();
    return this.snapshot();
  }

  private async runLevel(level: string[]): Promise<void> {
    const queue = [...level];
    const workers = Array.from(
      { length: Math.min(this.opts.concurrency, queue.length) },
      async () => {
        while (queue.length) {
          if (this.opts.signal.aborted) throw new AbortError();
          const key = queue.shift() as string;
          const repo = this.opts.config.repos.find((r) => r.key === key);
          if (repo) await this.buildRepo(repo);
        }
      },
    );
    await Promise.all(workers);
  }

  private async buildRepo(repo: RepoNode): Promise<void> {
    const step = this.plan.steps[repo.key];
    // Upstream repos that are not part of this plan are considered already built.
    const blocked = repo.dependsOn.filter(
      (dep) => this.plan.steps[dep] && this.plan.steps[dep].status !== 'success',
    );

    if (blocked.length) {
      step.status = 'skipped';
      step.error = `Upstream not ready: ${blocked.join(', ')}`;
      this.opts.onLog(`Skipped ${repo.key}: ${step.error}`, 'warn');
      this.emit();
      return;
    }

    step.status = 'running';
    step.startedAt = Date.now();
    this.emit();
    this.opts.onLog(`Build started: ${repo.key} (${repo.workflows.length} workflow(s))`, 'info');

    try {
      const client = await this.opts.clientFor(repo);

      for (const workflow of repo.workflows) {
        if (this.opts.signal.aborted) throw new AbortError();
        const outcome = await this.runWorkflow(client, repo, workflow, step);
        if (outcome.conclusion !== 'success' && !workflow.optional) {
          throw new Error(`Workflow ${workflow.file} finished with ${outcome.conclusion ?? outcome.status}`);
        }
      }

      step.status = 'success';
      step.finishedAt = Date.now();
      this.opts.onLog(`Build finished: ${repo.key}`, 'ok');
    } catch (err) {
      step.finishedAt = Date.now();
      if (err instanceof AbortError) {
        step.status = 'cancelled';
        this.opts.onLog(`Cancelled ${repo.key}`, 'warn');
        this.emit();
        throw err;
      }
      step.status = 'failure';
      step.error = (err as Error).message;
      this.opts.onLog(`Build failed for ${repo.key}: ${step.error}`, 'error');
    }
    this.emit();
  }

  private async runWorkflow(
    client: GitProviderClient,
    repo: RepoNode,
    workflow: WorkflowSpec,
    step: RunStep,
  ): Promise<{ headSha: string; conclusion: string | null; status: string }> {
    const ref = workflow.ref ?? repo.branch;
    const baseline = await client.latestRunId(repo.repo, workflow.file);
    const dispatched = await client.dispatchWorkflow(repo.repo, workflow.file, {
      ref,
      inputs: workflow.inputs,
    });
    this.opts.onLog(`Dispatched ${workflow.file} on ${repo.key} (ref=${ref})`, 'info');

    const run = dispatched.runId
      ? await this.waitForRunId(client, repo, dispatched.runId)
      : await this.waitForRun(client, repo, workflow.file, baseline);
    const record = {
      file: workflow.file,
      runId: run.id,
      htmlUrl: run.htmlUrl,
      status: run.status,
      conclusion: run.conclusion,
    };
    step.runs.push(record);
    this.emit();
    this.opts.onLog(`Run ${run.id} of ${repo.key} is ${run.status}`, 'info');

    const finished = await this.waitForCompletion(client, repo, run, record);
    return {
      headSha: finished.headSha,
      conclusion: finished.conclusion,
      status: finished.status,
    };
  }

  private async waitForRunId(
    client: GitProviderClient,
    repo: RepoNode,
    runId: string,
  ) {
    const deadline = Date.now() + this.dispatchTimeout;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      if (this.opts.signal.aborted) throw new AbortError();
      try {
        return await client.run(repo.repo, runId);
      } catch (err) {
        lastError = err as Error;
        await this.sleep(Math.min(this.pollInterval, 2000));
      }
    }
    throw new Error(
      `Dispatched run ${runId} but could not read it within ${Math.round(this.dispatchTimeout / 1000)}s: ${lastError?.message ?? 'timeout'}`,
    );
  }

  private async waitForRun(
    client: GitProviderClient,
    repo: RepoNode,
    file: string,
    baseline: string | null,
  ) {
    const deadline = Date.now() + this.dispatchTimeout;
    while (Date.now() < deadline) {
      if (this.opts.signal.aborted) throw new AbortError();
      const latestId = await client.latestRunId(repo.repo, file);
      if (latestId && latestId !== baseline) {
        return client.run(repo.repo, latestId);
      }
      await this.sleep(this.pollInterval);
    }
    throw new Error(
      `Timed out after ${Math.round(this.dispatchTimeout / 1000)}s waiting for a run of ${file}`,
    );
  }

  private async waitForCompletion(
    client: GitProviderClient,
    repo: RepoNode,
    run: Awaited<ReturnType<GitProviderClient['run']>>,
    record: RunStep['runs'][number],
  ) {
    let current = run;
    const deadline = Date.now() + this.runTimeout;

    if (current.status !== 'completed') {
      record.status = current.status;
      this.emit();
    }

    while (current.status !== 'completed') {
      if (this.opts.signal.aborted) throw new AbortError();
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for run ${current.id} to finish`);
      }
      await this.sleep(this.pollInterval);
      current = await client.run(repo.repo, current.id);
      record.status = current.status;
      record.conclusion = current.conclusion;
      this.emit();
    }
    return current;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opts.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        this.opts.signal.removeEventListener('abort', onAbort);
        reject(new AbortError());
      };
      if (this.opts.signal.aborted) {
        onAbort();
        return;
      }
      this.opts.signal.addEventListener('abort', onAbort);
    });
  }

  private emit(): void {
    this.opts.onPlan(this.snapshot());
  }

  private snapshot(): PlanState {
    const steps: PlanState['steps'] = {};
    for (const [key, step] of Object.entries(this.plan.steps)) {
      steps[key] = { ...step, runs: step.runs.map((run) => ({ ...run })) };
    }
    return { ...this.plan, levels: this.plan.levels.map((level) => [...level]), steps };
  }
}
