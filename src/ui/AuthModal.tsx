import { useEffect, useRef, useState } from 'react';
import { useApp } from '../core/store';
import { getPlugin } from '../plugins/registry';
import type { AuthStrategy, DeviceCode } from '../plugins/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

const STRATEGY_LABEL: Record<AuthStrategy, string> = {
  'device-flow': 'Device Flow',
  'oauth-web': 'OAuth2 Web',
  pat: 'Access token',
};

export function AuthModal({ open, onClose, onOpenSettings }: Props) {
  const providerId = useApp((s) => s.providerId);
  const credential = useApp((s) => s.credentials[s.providerId] ?? null);
  const settings = useApp((s) => s.settings);
  const setCredential = useApp((s) => s.setCredential);
  const log = useApp((s) => s.log);

  const plugin = getPlugin(providerId);
  const [tab, setTab] = useState<AuthStrategy>('device-flow');
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(plugin.auth?.strategies[0] ?? 'pat');
    setError(null);
    setDevice(null);
    setBusy(false);
    setPat('');
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [open, plugin]);

  useEffect(() => {
    if (open) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setDevice(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;

  const auth = plugin.auth;
  const ctx = {
    relayUrl: settings.relayUrl.trim() || undefined,
    scopes: settings.scopes,
  };

  const finish = async (token: string, scopes: string[], strategy: AuthStrategy) => {
    setBusy(true);
    let login: string | undefined;
    try {
      const client = plugin.createClient(
        { provider: plugin.id, token, strategy, scopes, obtainedAt: Date.now() },
        { apiBase: settings.apiBase },
      );
      login = (await client.viewer()).login;
    } catch (err) {
      log(`Signed in, but profile lookup failed: ${(err as Error).message}`, 'warn');
    }
    setCredential({ provider: plugin.id, token, strategy, scopes, login, obtainedAt: Date.now() });
    log(`Signed in to ${plugin.label}${login ? ` as ${login}` : ''}`, 'ok');
    setBusy(false);
    onClose();
  };

  const startDeviceFlow = async () => {
    if (!auth?.deviceFlow) return;
    setBusy(true);
    setError(null);
    try {
      const code = await auth.deviceFlow.start(ctx);
      setDevice(code);
      const tick = async () => {
        try {
          const result = await auth.deviceFlow?.poll(ctx, code.deviceCode);
          if (!result) return;
          if (result.status === 'ok' && result.token) {
            await finish(result.token, result.scopes ?? [], 'device-flow');
            return;
          }
          if (result.status === 'expired') {
            setError('The device code expired. Start again.');
            setBusy(false);
            return;
          }
          if (result.status === 'denied') {
            setError('Authorization was denied.');
            setBusy(false);
            return;
          }
          const delay = (result.status === 'slow_down' ? code.interval + 5 : code.interval) * 1000;
          timer.current = window.setTimeout(tick, delay);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      };
      timer.current = window.setTimeout(tick, code.interval * 1000);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const startWebFlow = () => {
    if (!auth?.webFlow) return;
    try {
      const state = crypto.randomUUID();
      sessionStorage.setItem('imagechain:oauth-state', state);
      sessionStorage.setItem('imagechain:oauth-provider', plugin.id);
      const redirectUri = window.location.origin + window.location.pathname;
      window.location.href = auth.webFlow.authorizeUrl({ ...ctx, redirectUri, state });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      log('Device code copied to clipboard', 'info');
    } catch {
      setError('Clipboard access denied; copy the code manually.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Connect {plugin.label}</h2>
            <p className="muted">{plugin.description}</p>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>

        {credential ? (
          <div className="signed-in">
            <div className="alert ok">
              Signed in{credential.login ? ` as ${credential.login}` : ''} via {STRATEGY_LABEL[credential.strategy]}
            </div>
            <div className="kv">
              <span>Scopes</span>
              <strong className="mono">{credential.scopes.join(', ') || 'unknown'}</strong>
            </div>
            <button
              className="danger"
              onClick={() => {
                setCredential(null);
                log(`Signed out of ${plugin.label}`, 'warn');
                onClose();
              }}
            >
              Sign out
            </button>
          </div>
        ) : auth ? (
          <>
            <nav className="tabs">
              {auth.strategies.map((strategy) => (
                <button
                  key={strategy}
                  className={tab === strategy ? 'active' : ''}
                  onClick={() => {
                    setTab(strategy);
                    setError(null);
                    setDevice(null);
                  }}
                >
                  {STRATEGY_LABEL[strategy]}
                </button>
              ))}
            </nav>

            {error && <div className="alert error">{error}</div>}

            {tab === 'device-flow' && (
              <div className="auth-pane">
                <p className="muted">
                  Enter the code on GitHub. No client secret is used, so this works from a static
                  site through an optional relay.
                </p>
                {device ? (
                  <div className="device-box">
                    <div className="device-code">{device.userCode}</div>
                    <div className="row">
                      <button onClick={copyCode}>Copy code</button>
                      <a
                        className="button primary"
                        href={device.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open GitHub
                      </a>
                    </div>
                    <div className="muted">Waiting for authorization…</div>
                  </div>
                ) : (
                  <button className="primary" disabled={busy} onClick={startDeviceFlow}>
                    {busy ? 'Starting…' : 'Start device flow'}
                  </button>
                )}
              </div>
            )}

            {tab === 'oauth-web' && (
              <div className="auth-pane">
                <p className="muted">
                  Redirects to GitHub and exchanges the code on your relay, which holds the client
                  secret. Requires a relay URL below.
                </p>
                <button className="primary" onClick={startWebFlow}>
                  Continue with GitHub
                </button>
              </div>
            )}

            {tab === 'pat' && (
              <div className="auth-pane">
                <p className="muted">{auth.pat?.hint}</p>
                <input
                  className="mono"
                  type="password"
                  placeholder={auth.pat?.placeholder}
                  value={pat}
                  onChange={(event) => setPat(event.target.value)}
                  autoComplete="off"
                />
                <button
                  className="primary"
                  disabled={busy || pat.trim().length < 8}
                  onClick={() => void finish(pat.trim(), [], 'pat')}
                >
                  Save token
                </button>
              </div>
            )}

            <button
              className="link"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              Configure OAuth in Settings
            </button>
          </>
        ) : (
          <div className="alert">This provider needs no authentication.</div>
        )}
      </div>
    </div>
  );
}
