import type { AuthContext, AuthProvider, DevicePollResult, WebFlowContext } from '../types';

const trim = (url: string): string => url.replace(/\/+$/, '');

function relay(ctx: AuthContext): string {
  const url = ctx.relayUrl?.trim();
  if (!url) {
    throw new Error(
      'Sign-in needs a relay: browsers cannot call github.com OAuth endpoints (no CORS). Set the relay URL in settings, or use a personal access token.',
    );
  }
  return trim(url);
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach ${url}: ${(err as Error).message}. Browsers cannot call github.com OAuth endpoints directly (no CORS). Configure a relay URL or use a personal access token.`,
    );
  }
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Unexpected response from ${url}: ${text.slice(0, 160)}`);
  }
  return data;
}

function parseScopes(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export const githubAuth: AuthProvider = {
  strategies: ['device-flow', 'oauth-web', 'pat'],

  deviceFlow: {
    async start(ctx: AuthContext) {
      const data = await postForm(`${relay(ctx)}/device/code`, { scope: ctx.scopes });
      if (data.error) throw new Error(String(data.error_description ?? data.error));
      return {
        deviceCode: String(data.device_code),
        userCode: String(data.user_code),
        verificationUri: String(data.verification_uri),
        expiresIn: Number(data.expires_in ?? 900),
        interval: Number(data.interval ?? 5),
      };
    },

    async poll(ctx: AuthContext, deviceCode: string): Promise<DevicePollResult> {
      const data = await postForm(`${relay(ctx)}/oauth/access_token`, {
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (data.access_token) {
        return { status: 'ok', token: String(data.access_token), scopes: parseScopes(data.scope) };
      }
      switch (data.error) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return { status: 'slow_down' };
        case 'expired_token':
          return { status: 'expired' };
        case 'access_denied':
          return { status: 'denied' };
        default:
          return {
            status: 'pending',
            message: String(data.error_description ?? data.error ?? 'pending'),
          };
      }
    },
  },

  webFlow: {
    authorizeUrl(ctx: WebFlowContext) {
      const params = new URLSearchParams({
        redirect_uri: ctx.redirectUri,
        scope: ctx.scopes,
        state: ctx.state,
      });
      return `${relay(ctx)}/oauth/authorize?${params.toString()}`;
    },

    async exchange(ctx: WebFlowContext) {
      const data = await postForm(`${relay(ctx)}/oauth/exchange`, {
        code: String(ctx.code ?? ''),
        redirect_uri: ctx.redirectUri,
      });
      if (!data.access_token) {
        throw new Error(String(data.error_description ?? data.error ?? 'Token exchange failed'));
      }
      return { token: String(data.access_token), scopes: parseScopes(data.scope) };
    },
  },

  pat: {
    placeholder: 'ghp_xxx or github_pat_xxx',
    hint: 'Fine-grained or classic token with repo + workflow scopes. Stored only in this browser.',
  },
};
