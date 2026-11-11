import type { GitProviderPlugin } from './types';
import { demoPlugin } from './demo';
import { githubPlugin } from './github';

export const plugins: GitProviderPlugin[] = [githubPlugin, demoPlugin];

export function getPlugin(id: string): GitProviderPlugin {
  const found = plugins.find((plugin) => plugin.id === id);
  if (!found) throw new Error(`Unknown Git provider plugin: ${id}`);
  return found;
}
