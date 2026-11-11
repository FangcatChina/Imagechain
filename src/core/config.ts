import { parse as parseYaml } from 'yaml';
import type { ChainConfig, RepoNode, WorkflowSpec } from './types';

export interface ParseResult {
  config: ChainConfig | null;
  errors: string[];
}

export function parseConfig(text: string): ParseResult {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { config: null, errors: [`Invalid YAML: ${(err as Error).message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { config: null, errors: ['Root node must be an object'] };
  }

  const root = doc as Record<string, unknown>;
  const defaults = (root.defaults ?? {}) as Record<string, unknown>;
  const provider = String(root.provider ?? defaults.provider ?? 'github');
  const branch = String(root.branch ?? defaults.branch ?? 'main');
  const concurrency = Math.max(
    1,
    Math.min(16, Number(root.concurrency ?? defaults.concurrency ?? 2) || 2),
  );

  const entries: Array<[string | undefined, unknown]> = [];
  const rawRepos = root.repos;
  if (Array.isArray(rawRepos)) {
    rawRepos.forEach((item) => entries.push([undefined, item]));
  } else if (rawRepos && typeof rawRepos === 'object') {
    Object.entries(rawRepos as Record<string, unknown>).forEach(([k, v]) => entries.push([k, v]));
  } else {
    errors.push('Missing repos list');
  }

  const repos: RepoNode[] = [];
  for (const [mapKey, rawItem] of entries) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      errors.push(`Repository entry must be an object: ${String(rawItem)}`);
      continue;
    }
    const value = rawItem as Record<string, unknown>;
    const slug = String(value.repo ?? value.name ?? mapKey ?? '').trim();
    const [owner, name] = slug.split('/');
    if (!owner || !name) {
      errors.push(`Repository "${mapKey ?? slug}" must use owner/name form`);
      continue;
    }
    const key = String(value.key ?? mapKey ?? name);

    const workflows: WorkflowSpec[] = [];
    const pushWorkflow = (wf: unknown) => {
      if (typeof wf === 'string') {
        workflows.push({ file: wf });
      } else if (wf && typeof wf === 'object') {
        const item = wf as Record<string, unknown>;
        if (!item.file) {
          errors.push(`Workflow of ${key} is missing file`);
          return;
        }
        workflows.push({
          file: String(item.file),
          ref: item.ref ? String(item.ref) : undefined,
          inputs: item.inputs as Record<string, string> | undefined,
          optional: Boolean(item.optional),
        });
      } else {
        errors.push(`Invalid workflow definition for ${key}`);
      }
    };
    const rawWorkflows = value.workflows;
    if (Array.isArray(rawWorkflows)) rawWorkflows.forEach(pushWorkflow);
    else if (rawWorkflows === undefined) errors.push(`Repository ${key} is missing workflows`);
    else pushWorkflow(rawWorkflows);
    if (!workflows.length && rawWorkflows !== undefined) {
      errors.push(`Repository ${key} needs at least one workflow`);
    }

    const dependsOn = Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [];

    repos.push({
      key,
      provider: String(value.provider ?? provider),
      repo: { owner, name },
      url: String(value.url ?? `https://github.com/${owner}/${name}.git`),
      description: String(value.description ?? ''),
      branch: String(value.branch ?? branch),
      dependsOn,
      workflows,
      labels: Array.isArray(value.labels) ? value.labels.map(String) : [],
    });
  }

  const keys = new Set<string>();
  for (const repo of repos) {
    if (keys.has(repo.key)) errors.push(`Duplicate repository key: ${repo.key}`);
    keys.add(repo.key);
  }
  for (const repo of repos) {
    for (const dep of repo.dependsOn) {
      if (dep === repo.key) errors.push(`${repo.key} cannot depend on itself`);
      else if (!keys.has(dep)) errors.push(`${repo.key} depends on unknown repository ${dep}`);
    }
  }

  const config: ChainConfig = {
    version: Number(root.version ?? 1),
    provider,
    branch,
    concurrency,
    repos,
  };
  return { config: errors.length ? null : config, errors };
}
