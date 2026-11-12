import type { RepoNode } from './types';

export interface DependencyGraph {
  levels: string[][];
  order: string[];
  dependents: Record<string, string[]>;
  errors: string[];
}

export function buildGraph(repos: RepoNode[]): DependencyGraph {
  const errors: string[] = [];
  const byKey = new Map(repos.map((r) => [r.key, r]));
  const indegree = new Map<string, number>();
  const dependents: Record<string, string[]> = {};

  for (const repo of repos) {
    indegree.set(repo.key, 0);
    dependents[repo.key] = [];
  }
  for (const repo of repos) {
    for (const dep of repo.dependsOn) {
      if (dep === repo.key) {
        errors.push(`${repo.key} cannot depend on itself`);
        continue;
      }
      if (!byKey.has(dep)) {
        errors.push(`${repo.key} depends on unknown repository "${dep}"`);
        continue;
      }
      indegree.set(repo.key, (indegree.get(repo.key) ?? 0) + 1);
      dependents[dep].push(repo.key);
    }
  }

  const levels: string[][] = [];
  const seen = new Set<string>();
  let ready = repos
    .filter((r) => (indegree.get(r.key) ?? 0) === 0)
    .map((r) => r.key)
    .sort();

  while (ready.length) {
    levels.push(ready);
    ready.forEach((k) => seen.add(k));
    const next: string[] = [];
    for (const key of ready) {
      for (const child of dependents[key]) {
        const left = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, left);
        if (left === 0) next.push(child);
      }
    }
    ready = next.sort();
  }

  if (seen.size !== repos.length) {
    const stuck = repos.filter((r) => !seen.has(r.key)).map((r) => r.key);
    errors.push(`Circular dependency detected: ${stuck.join(' -> ')}`);
  }

  return { levels, order: [...seen], dependents, errors };
}

export function relatedKeys(key: string, repos: RepoNode[]): Set<string> {
  const byKey = new Map(repos.map((r) => [r.key, r]));
  const out = new Set<string>([key]);

  const up = [key];
  while (up.length) {
    const cur = byKey.get(up.pop() as string);
    if (!cur) continue;
    for (const dep of cur.dependsOn) {
      if (!out.has(dep)) {
        out.add(dep);
        up.push(dep);
      }
    }
  }

  const down = [key];
  while (down.length) {
    const cur = down.pop() as string;
    for (const repo of repos) {
      if (repo.dependsOn.includes(cur) && !out.has(repo.key)) {
        out.add(repo.key);
        down.push(repo.key);
      }
    }
  }
  return out;
}

export function descendantKeys(key: string, repos: RepoNode[]): Set<string> {
  const out = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const repo of repos) {
      if (repo.dependsOn.includes(current) && !out.has(repo.key)) {
        out.add(repo.key);
        stack.push(repo.key);
      }
    }
  }
  return out;
}

export function withDescendants(repos: RepoNode[], keys: string[]): RepoNode[] {
  const keep = new Set<string>();
  for (const key of keys) {
    if (!repos.some((repo) => repo.key === key)) continue;
    keep.add(key);
    for (const dependent of descendantKeys(key, repos)) keep.add(dependent);
  }
  return repos.filter((repo) => keep.has(repo.key));
}
