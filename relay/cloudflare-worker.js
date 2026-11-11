const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });

async function proxyForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return json(await res.json(), res.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/health') {
      return json({ ok: true, oauthWeb: Boolean(env.GITHUB_CLIENT_SECRET) });
    }

    if (url.pathname === '/device/code' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return proxyForm('https://github.com/login/device/code', {
        client_id: body.client_id || env.GITHUB_CLIENT_ID,
        scope: body.scope || 'repo workflow read:user',
      });
    }

    if (url.pathname === '/oauth/access_token' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return proxyForm('https://github.com/login/oauth/access_token', {
        client_id: body.client_id || env.GITHUB_CLIENT_ID,
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
      const body = await request.json().catch(() => ({}));
      return proxyForm('https://github.com/login/oauth/access_token', {
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: body.code,
        redirect_uri: body.redirect_uri,
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
