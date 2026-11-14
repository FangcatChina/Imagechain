export interface SharedConfig {
  text: string;
  select?: string;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function searchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search.replace(/^\?/, ''));
}

export function readSharedConfig(): SharedConfig | null {
  const encoded = hashParams().get('config');
  if (!encoded) return null;

  try {
    return {
      text: decodeBase64Url(encoded),
      select: hashParams().get('select') ?? undefined,
    };
  } catch {
    return null;
  }
}

export function readSharedConfigUrl(): string | null {
  const url = searchParams().get('config');
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export function clearSharedConfig(): void {
  const hash = hashParams();
  hash.delete('config');
  hash.delete('select');

  const search = searchParams();
  search.delete('config');

  const query = search.toString();
  const fragment = hash.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
  window.history.replaceState({}, '', next);
}

