const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, accept, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
  'access-control-expose-headers':
    'x-oauth-scopes, x-accepted-github-permissions, x-ratelimit-remaining, x-ratelimit-reset, link',
};

const DEFAULT_SCOPE = 'repo workflow read:user';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });

async function readBody(request) {
  const text = (await request.text()).trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function proxyForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!text) return json({}, res.status);
  try {
    return json(JSON.parse(text), res.status);
  } catch {
    return json({ error: 'bad_gateway', error_description: text.slice(0, 300) }, 502);
  }
}

const relayCallbackUrl = (origin) => `${origin}/oauth/callback`;

const b64url = (value) =>
  btoa(encodeURIComponent(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
};

const packState = (state, app) => (app ? `${state}.${b64url(app)}` : state);

const unpackState = (packed) => {
  const cut = packed.lastIndexOf('.');
  if (cut === -1) return { state: packed, app: '' };
  try {
    return { state: packed.slice(0, cut), app: unb64url(packed.slice(cut + 1)) };
  } catch {
    return { state: packed, app: '' };
  }
};

const githubTokenUrl = 'https://github.com/login/oauth/access_token';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/health') {
      return json({
        ok: true,
        oauthWeb: Boolean(env.GITHUB_CLIENT_SECRET),
        callback: `${url.origin}/oauth/callback`,
      });
    }

    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      if (!env.GITHUB_CLIENT_ID) {
        return json({ error: 'oauth_disabled', error_description: 'GITHUB_CLIENT_ID is not set' }, 400);
      }
      const app = url.searchParams.get('redirect_uri') || url.searchParams.get('app') || '';
      if (!app) {
        return json(
          { error: 'invalid_request', error_description: 'redirect_uri is required' },
          400,
        );
      }
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        // Must equal the callback URL registered on the app, so it cannot carry the app address.
        redirect_uri: relayCallbackUrl(url.origin),
        scope: url.searchParams.get('scope') || DEFAULT_SCOPE,
        state: packState(url.searchParams.get('state') || '', app),
        allow_signup: 'true',
      });
      return Response.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`, 302);
    }

    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      const { state, app } = unpackState(url.searchParams.get('state') || '');
      if (!app) {
        return json(
          {
            error: 'invalid_request',
            error_description:
              'state does not carry the app URL: start at /oauth/authorize?redirect_uri=<app>',
          },
          400,
        );
      }
      let target;
      try {
        target = new URL(app);
      } catch {
        return json(
          { error: 'invalid_request', error_description: `app is not a valid URL: ${app}` },
          400,
        );
      }
      for (const key of ['code', 'scope', 'error', 'error_description', 'error_uri']) {
        const value = url.searchParams.get(key);
        if (value !== null) target.searchParams.set(key, value);
      }
      if (state) target.searchParams.set('state', state);
      return Response.redirect(target.toString(), 302);
    }

    if (url.pathname === '/device/code' && request.method === 'POST') {
      if (!env.GITHUB_CLIENT_ID) {
        return json({ error: 'oauth_disabled', error_description: 'GITHUB_CLIENT_ID is not set' }, 400);
      }
      const body = await readBody(request);
      return proxyForm('https://github.com/login/device/code', {
        client_id: env.GITHUB_CLIENT_ID,
        scope: body.scope || DEFAULT_SCOPE,
      });
    }

    if (url.pathname === '/oauth/access_token' && request.method === 'POST') {
      if (!env.GITHUB_CLIENT_ID) {
        return json({ error: 'oauth_disabled', error_description: 'GITHUB_CLIENT_ID is not set' }, 400);
      }
      const body = await readBody(request);
      if (!body.device_code) {
        return json(
          { error: 'invalid_request', error_description: 'device_code is required' },
          400,
        );
      }
      return proxyForm(githubTokenUrl, {
        client_id: env.GITHUB_CLIENT_ID,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    }

    if (url.pathname === '/oauth/exchange' && request.method === 'POST') {
      if (!env.GITHUB_CLIENT_SECRET) {
        return json(
          { error: 'oauth_web_disabled', error_description: 'GITHUB_CLIENT_SECRET is not set' },
          400,
        );
      }
      const body = await readBody(request);
      if (!body.code) {
        return json({ error: 'invalid_request', error_description: 'code is required' }, 400);
      }
      return proxyForm(githubTokenUrl, {
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: body.code,
        // Must be byte-identical to the one used on /oauth/authorize.
        redirect_uri: relayCallbackUrl(url.origin),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      const target = `https://api.github.com${url.pathname.slice(4)}${url.search}`;
      const res = await fetch(target, {
        method: request.method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(request.headers.get('authorization')
            ? { Authorization: request.headers.get('authorization') }
            : {}),
          ...(request.headers.get('content-type')
            ? { 'Content-Type': request.headers.get('content-type') }
            : {}),
        },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: {
          ...CORS,
          'content-type': res.headers.get('content-type') || 'application/json',
        },
      });
    }

    return json({ error: 'not_found' }, 404);
  },
};
