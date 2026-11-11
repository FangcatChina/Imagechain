import { useEffect, useState } from 'react';
import { useApp } from '../core/store';
import type { BatchResult } from '../core/store';
import { statusText } from '../core/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function BatchPublishModal({ open, onClose }: Props) {
  const config = useApp((s) => s.config);
  const baseline = useApp((s) => s.baseline);
  const pushTagBatch = useApp((s) => s.pushTagBatch);
  const publishReleaseBatch = useApp((s) => s.publishReleaseBatch);

  const [mode, setMode] = useState<'tag' | 'release'>('tag');
  const [selected, setSelected] = useState<string[]>([]);
  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('tag');
    setSelected((config?.repos ?? []).map((repo) => repo.key));
    setTag('');
    setTitle('');
    setResults(null);
    setError(null);
    setBusy(false);
  }, [open, config]);

  if (!open) return null;

  const toggle = (key: string) => {
    setSelected((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
  };

  const submit = async () => {
    if (!selected.length) {
      setError('Select at least one repository');
      return;
    }
    if (!tag.trim()) {
      setError('Tag is required');
      return;
    }
    setBusy(true);
    setError(null);
    const outcome =
      mode === 'tag'
        ? await pushTagBatch(selected, tag)
        : await publishReleaseBatch(selected, { tag, title });
    setResults(outcome);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Batch publish</h2>
            <p className="muted">Apply the same tag or release to several repositories.</p>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>

        <nav className="tabs">
          {(['tag', 'release'] as const).map((item) => (
            <button
              key={item}
              className={mode === item ? 'active' : ''}
              onClick={() => {
                setMode(item);
                setResults(null);
              }}
            >
              {item === 'tag' ? 'Tag repositories' : 'Release repositories'}
            </button>
          ))}
        </nav>

        <div className="rules">
          <div className="row spread">
            <span className="muted">
              {selected.length} of {config?.repos.length ?? 0} selected
            </span>
            <div className="row">
              <button
                className="link"
                onClick={() => setSelected((config?.repos ?? []).map((repo) => repo.key))}
              >
                Select all
              </button>
              <button className="link" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          </div>

          <div className="dep-list">
            {(config?.repos ?? []).map((repo) => (
              <label className="check" key={repo.key}>
                <input
                  type="checkbox"
                  checked={selected.includes(repo.key)}
                  onChange={() => toggle(repo.key)}
                />
                {repo.key}
                <span className={`muted mono`}>{statusText[baseline[repo.key]?.build ?? 'idle']}</span>
              </label>
            ))}
          </div>

          <label className="field-block">
            Tag
            <input
              className="mono"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="v1.4.0"
            />
          </label>

          {mode === 'release' && (
            <label className="field-block">
              Release title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={tag || 'Release title'}
              />
            </label>
          )}

          {error && <div className="alert error">{error}</div>}

          {results && (
            <div className="results">
              {results.map((item) => (
                <div className={`result ${item.ok ? 'ok' : 'bad'}`} key={item.key}>
                  <span className="mono">{item.key}</span>
                  <span>{item.ok ? 'done' : item.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <button onClick={onClose}>{results ? 'Close' : 'Cancel'}</button>
          <button className="primary" disabled={busy || !selected.length || !tag.trim()} onClick={() => void submit()}>
            {busy ? 'Working…' : mode === 'tag' ? `Tag ${selected.length}` : `Release ${selected.length}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
