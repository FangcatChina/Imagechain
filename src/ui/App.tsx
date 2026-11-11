import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../core/store';
import { getPlugin } from '../plugins/registry';
import { GraphView } from './GraphView';
import { RepoDetail } from './RepoDetail';
import { AuthModal } from './AuthModal';
import { RepoEditor } from './RepoEditor';
import { BatchPublishModal } from './BatchPublishModal';
import { SettingsPage } from './SettingsPage';

export default function App() {
  const config = useApp((s) => s.config);
  const configErrors = useApp((s) => s.configErrors);
  const providerId = useApp((s) => s.providerId);
  const credential = useApp((s) => s.credentials[s.providerId] ?? null);
  const plan = useApp((s) => s.plan);
  const baseline = useApp((s) => s.baseline);
  const baselineLoading = useApp((s) => s.baselineLoading);
  const loadBaseline = useApp((s) => s.loadBaseline);
  const running = useApp((s) => s.running);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const startPlan = useApp((s) => s.startPlan);
  const cancelPlan = useApp((s) => s.cancelPlan);
  const resetConfig = useApp((s) => s.resetConfig);
  const log = useApp((s) => s.log);

  const [authOpen, setAuthOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [view, setView] = useState<'graph' | 'settings'>('graph');
  const [notice, setNotice] = useState<string | null>(null);

  const provider = getPlugin(providerId);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return;

    const savedState = sessionStorage.getItem('imagechain:oauth-state');
    const savedProvider = sessionStorage.getItem('imagechain:oauth-provider');
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);

    if (!savedState || savedState !== state) {
      log('OAuth2 callback rejected: state mismatch', 'error');
      return;
    }
    sessionStorage.removeItem('imagechain:oauth-state');

    const store = useApp.getState();
    const plugin = getPlugin(savedProvider ?? store.providerId);
    const webFlow = plugin.auth?.webFlow;
    if (!webFlow) {
      log(`${plugin.label} does not implement OAuth2 web flow`, 'error');
      return;
    }
    const redirectUri = window.location.origin + window.location.pathname;
    webFlow
      .exchange({ ...store.settings, redirectUri, state, code })
      .then(async (result) => {
        let login: string | undefined;
        try {
          const client = plugin.createClient(
            {
              provider: plugin.id,
              token: result.token,
              strategy: 'oauth-web',
              scopes: result.scopes,
              obtainedAt: Date.now(),
            },
            { apiBase: store.settings.apiBase },
          );
          login = (await client.viewer()).login;
        } catch {
          login = undefined;
        }
        useApp.getState().setProvider(plugin.id);
        useApp.getState().setCredential({
          provider: plugin.id,
          token: result.token,
          strategy: 'oauth-web',
          scopes: result.scopes,
          obtainedAt: Date.now(),
          login,
        });
        log(`OAuth2 sign-in complete${login ? ` as ${login}` : ''}`, 'ok');
      })
      .catch((err: Error) => log(`OAuth2 exchange failed: ${err.message}`, 'error'));
  }, [log]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    void loadBaseline();
  }, [providerId, config, loadBaseline]);

  const stats = useMemo(() => {
    const counts = { success: 0, failure: 0, running: 0, pending: 0, skipped: 0 };
    for (const repo of config?.repos ?? []) {
      const stepStatus = plan?.steps[repo.key]?.status;
      const status = stepStatus && stepStatus !== 'idle' ? stepStatus : baseline[repo.key]?.build ?? 'idle';
      if (status === 'success') counts.success += 1;
      else if (status === 'failure') counts.failure += 1;
      else if (status === 'running' || status === 'queued') counts.running += 1;
      else if (status === 'skipped' || status === 'cancelled') counts.skipped += 1;
      else counts.pending += 1;
    }
    return counts;
  }, [config, plan, baseline]);

  const run = async (keys?: string[]) => {
    if (provider.requiresAuth && !credential) {
      setAuthOpen(true);
      return;
    }
    const result = await startPlan(keys);
    if (!result.ok) setNotice(result.error ?? 'Plan failed');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" role="img" aria-label="Imagechain">
              <g fill="#fffefb" stroke="#333333" strokeWidth="1.1" strokeLinejoin="round">
                <ellipse cx="12" cy="6.2" rx="3.1" ry="4.2" />
                <ellipse cx="12" cy="6.2" rx="3.1" ry="4.2" transform="rotate(72 12 12)" />
                <ellipse cx="12" cy="6.2" rx="3.1" ry="4.2" transform="rotate(144 12 12)" />
                <ellipse cx="12" cy="6.2" rx="3.1" ry="4.2" transform="rotate(216 12 12)" />
                <ellipse cx="12" cy="6.2" rx="3.1" ry="4.2" transform="rotate(288 12 12)" />
              </g>
              <circle cx="12" cy="12" r="2.6" fill="#333333" />
            </svg>
          </span>
          <div>
            <h1>Imagechain</h1>
            <p>Dependency-aware image build orchestrator</p>
          </div>
        </div>

        <div className="topbar-mid">
          {plan && (
            <span className={`chip plan ${plan.status}`}>
              {plan.status === 'running' ? 'Plan running' : `Plan ${plan.status}`}
            </span>
          )}
        </div>

        <div className="topbar-actions">
          {view === 'graph' && (
            <>
              <button onClick={() => setEditorOpen(true)}>+ Add image</button>
              <button onClick={() => setBatchOpen(true)}>Batch publish</button>
              {running ? (
                <button className="danger" onClick={cancelPlan}>
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={() => void run()}>
                  Run plan
                </button>
              )}
              <button
                className="icon gear"
                title="Settings"
                aria-label="Settings"
                onClick={() => setView('settings')}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      {configErrors.length > 0 && (
        <div className="banner">
          Configuration is invalid: {configErrors[0]}
          <button className="link" onClick={resetConfig}>
            Reset configuration
          </button>
        </div>
      )}

      {view === 'settings' ? (
        <SettingsPage
          onBack={() => setView('graph')}
          onConnect={() => setAuthOpen(true)}
        />
      ) : (
        <main className="workspace">
          <section className="canvas">
          <div className="canvas-head">
            <div>
              <h2>Dependency graph</h2>
              <p className="muted">
                {config?.repos.length ?? 0} repositories · concurrency {config?.concurrency ?? 1} ·{' '}
                {baselineLoading ? 'syncing last builds…' : 'showing last known state'}
              </p>
            </div>
            <div className="stats">
              <span className="stat success">{stats.success} ok</span>
              <span className="stat failure">{stats.failure} failed</span>
              <span className="stat running">{stats.running} active</span>
              <span className="stat pending">{stats.pending} no runs</span>
            </div>
          </div>

          {config && config.repos.length > 0 ? (
            <GraphView
              repos={config.repos}
              plan={plan}
              baseline={baseline}
              selected={selected}
              onSelect={(key) => select(key)}
            />
          ) : (
            <div className="empty">
              <p>No pipeline yet.</p>
              <button className="primary" onClick={() => setEditorOpen(true)}>
                Add the first image
              </button>
            </div>
          )}
        </section>

          {selected && <RepoDetail repoKey={selected} />}
        </main>
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onOpenSettings={() => {
          setAuthOpen(false);
          setView('settings');
        }}
      />
      <RepoEditor open={editorOpen} repoKey={null} onClose={() => setEditorOpen(false)} />
      <BatchPublishModal open={batchOpen} onClose={() => setBatchOpen(false)} />
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}
