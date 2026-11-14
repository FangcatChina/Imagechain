import { useState } from 'react';
import { useApp } from '../core/store';
import { getPlugin, plugins } from '../plugins/registry';

interface Props {
  onBack: () => void;
  onConnect: () => void;
}

export function SettingsPage({ onBack, onConnect }: Props) {
  const providerId = useApp((s) => s.providerId);
  const setProvider = useApp((s) => s.setProvider);
  const credential = useApp((s) => s.credentials[s.providerId] ?? null);
  const setCredential = useApp((s) => s.setCredential);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const configText = useApp((s) => s.configText);
  const importConfig = useApp((s) => s.importConfig);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = getPlugin(providerId);

  const exportYaml = () => {
    const blob = new Blob([configText], { type: 'text/yaml;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'imagechain.yaml';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const applyText = (text: string) => {
    if (importConfig(text)) {
      setError(null);
      return true;
    }
    setError(useApp.getState().configErrors[0] ?? 'Invalid configuration');
    return false;
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    applyText(await file.text());
  };

  const loadFromUrl = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      applyText(await res.text());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <header className="settings-head">
          <div>
            <h2>Settings</h2>
            <p className="muted">Provider, authentication and pipeline tools.</p>
          </div>
          <button onClick={onBack}>Back to graph</button>
        </header>

        <section className="settings-card">
          <div className="settings-card-head">
            <h3>Git provider</h3>
            <p className="muted">{provider.description}</p>
          </div>

          <div className="settings-grid">
            <label className="field-block">
              Provider
              <select value={providerId} onChange={(event) => setProvider(event.target.value)}>
                {plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>
                    {plugin.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="field-block">
              Connection
              <div className="row">
                <span className={credential ? 'chip auth ok' : 'chip'}>
                  {provider.requiresAuth
                    ? credential
                      ? `Connected as ${credential.login ?? 'unknown'}`
                      : 'Not connected'
                    : 'No authentication required'}
                </span>
                {provider.requiresAuth &&
                  (credential ? (
                    <button onClick={() => setCredential(null)}>Sign out</button>
                  ) : (
                    <button className="primary" onClick={onConnect}>
                      Connect
                    </button>
                  ))}
              </div>
            </div>
          </div>

          {provider.requiresAuth && (
            <div className="settings-grid">
              <label className="field-block">
                Relay URL
                <input
                  className="mono"
                  value={settings.relayUrl}
                  onChange={(event) => setSettings({ relayUrl: event.target.value })}
                  placeholder="https://imagechain-relay.example.workers.dev"
                />
              </label>
              <label className="field-block">
                API base
                <input
                  className="mono"
                  value={settings.apiBase}
                  onChange={(event) => setSettings({ apiBase: event.target.value })}
                  placeholder="https://api.github.com"
                />
              </label>
              <label className="field-block">
                Scopes
                <input
                  className="mono"
                  value={settings.scopes}
                  onChange={(event) => setSettings({ scopes: event.target.value })}
                />
              </label>
              <label className="field-block">
                Request interval (seconds)
                <input
                  type="number"
                  min={2}
                  step={1}
                  value={Math.round(settings.pollIntervalMs / 1000)}
                  onChange={(event) =>
                    setSettings({ pollIntervalMs: Math.max(2000, Number(event.target.value || 10) * 1000) })
                  }
                />
              </label>
            </div>
          )}
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h3>Configuration</h3>
            <p className="muted">
              Pipelines are stored as YAML. Export it, import a file, or load it from a URL.
            </p>
          </div>
          <div className="row wrap">
            <button onClick={exportYaml}>Export YAML</button>
            <label className="button">
              Import file
              <input
                type="file"
                accept=".yml,.yaml,text/yaml,text/plain"
                hidden
                onChange={(event) => void importFile(event.target.files?.[0])}
              />
            </label>
          </div>
          <div className="row">
            <input
              className="mono grow"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/imagechain.yaml"
            />
            <button disabled={!url.trim() || busy} onClick={() => void loadFromUrl()}>
              {busy ? 'Loading…' : 'Load from URL'}
            </button>
          </div>
          {error && <div className="alert error">{error}</div>}
        </section>
      </div>
    </div>
  );
}
