import { useEffect, useState } from 'react';
import { useApp } from '../core/store';

type Mode = 'tag' | 'release';

interface Props {
  open: boolean;
  mode: Mode;
  repoKey: string;
  onClose: () => void;
}

export function PublishModal({ open, mode, repoKey, onClose }: Props) {
  const detail = useApp((s) => s.details[repoKey]);
  const pushTag = useApp((s) => s.pushTag);
  const publishRelease = useApp((s) => s.publishRelease);

  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTag('');
    setTitle('');
    setError(null);
    setBusy(false);
  }, [open, mode]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result =
      mode === 'tag'
        ? await pushTag(repoKey, tag)
        : await publishRelease(repoKey, { tag, title });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? 'Request failed');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{mode === 'tag' ? 'Create tag' : 'Publish release'}</h2>
            <p className="muted">{repoKey}</p>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="rules">
          <label className="field-block">
            Tag
            <input
              className="mono"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="v1.4.0"
              list="known-tags"
              autoFocus
            />
          </label>
          <datalist id="known-tags">
            {(detail?.tags ?? []).map((item) => (
              <option key={item.name} value={item.name} />
            ))}
          </datalist>

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

          <p className="muted">
            {mode === 'tag'
              ? 'The tag points at the commit of the last successful build.'
              : 'Notes are generated from commits since the previous release unless the API returns none.'}
          </p>

          {error && <div className="alert error">{error}</div>}
        </div>

        <footer className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !tag.trim()} onClick={() => void submit()}>
            {mode === 'tag' ? 'Create tag' : 'Publish'}
          </button>
        </footer>
      </div>
    </div>
  );
}
