import type { GitProviderPlugin } from '../types';
import { githubAuth } from './auth';
import { GitHubClient } from './client';

export const githubPlugin: GitProviderPlugin = {
  id: 'github',
  label: 'GitHub',
  description: 'GitHub Actions dispatch, runs, tags and releases over REST.',
  accent: '#8b5cf6',
  requiresAuth: true,
  auth: githubAuth,
  createClient: (credential, options) =>
    new GitHubClient(credential.token, options?.apiBase ?? 'https://api.github.com'),
  repoUrl: (ref) => `https://github.com/${ref.owner}/${ref.name}`,
};
