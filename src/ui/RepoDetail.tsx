import { useEffect, useState } from 'react';
import { stringify } from 'yaml';
import { useApp } from '../core/store';
import { statusText } from '../core/types';
import { RepoEditor } from './RepoEditor';
import { PublishModal } from './PublishModal';

type Tab = 'overview' | 'builds' | 'commits' | 'config';

const formatDate = (value?: string): string => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

interface Props {
  repoKey: string;
}

export function RepoDetail({ repoKey }: Props) {
  const repo = useApp((s) => s.config?.repos.find((item) => item.key === repoKey) ?? null);
  const detail = useApp((s) => s.details[repoKey]);
  const step = useApp((s) => s.plan?.steps[repoKey]);
  const baseline = useApp((s) => s.baseline[repoKey]);
  const running = useApp((s) => s.running);
  const refreshDetail = useApp((s) => s.refreshDetail);
  const startPlan = useApp((s) => s.startPlan);
  const select = useApp((s) => s.select);

  const [tab, setTab] = useState<Tab>('overview');
  const [editorOpen, setEditorOpen] = useState(false);
  const [publishMode, setPublishMode] = useState<'tag' | 'release' | null>(null);

  useEffect(() => {
    if (!useApp.getState().details[repoKey]) void refreshDetail(repoKey);
  }, [repoKey, refreshDetail]);

  if (!repo) return null;

  const openUrl = detail?.meta?.htmlUrl ?? repo.url;
  const buildStatus = step && step.status !== 'idle' ? step.status : baseline?.build ?? 'idle';

  return (
    <aside className="detail">
      <header className="detail-head">
        <div>
          <div className="detail-key">{repo.key}</div>
          <a className="detail-repo" href={openUrl} target="_blank" rel="noreferrer">
            {repo.repo.owner}/{repo.repo.name}
          </a>
        </div>
        <button className="icon" onClick={() => select(null)} title="Close">
          ×
        </button>
      </header>

      <div className="detail-actions">
        <button className="primary" disabled={running} onClick={() => void startPlan([repoKey])}>
          Build + downstream
        </button>
        <button onClick={() => setPublishMode('tag')}>Tag</button>
        <button onClick={() => setPublishMode('release')}>Release</button>
        <button onClick={() => void refreshDetail(repoKey)}>Refresh</button>
        <button onClick={() => setEditorOpen(true)}>Edit</button>
      </div>

      <nav className="tabs">
        {(['overview', 'builds', 'commits', 'config'] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </nav>

      <div className="detail-body">
        {detail?.error && <div className="alert error">{detail.error}</div>}
        {detail?.loading && <div className="alert">Loading provider data…</div>}

        {tab === 'overview' && (
          <>
            {repo.description && <p className="detail-desc">{repo.description}</p>}

            <div className="kv">
              <span>Status</span>
              <strong className={`tone-${buildStatus}`}>{statusText[buildStatus]}</strong>
            </div>
            {baseline?.lastRun && (
              <div className="kv">
                <span>Last build</span>
                <strong>
                  <a className="inline-link" href={baseline.lastRun.htmlUrl} target="_blank" rel="noreferrer">
                    #{baseline.lastRun.id}
                  </a>{' '}
                  · {formatDate(baseline.lastRun.createdAt)}
                </strong>
              </div>
            )}
            <div className="kv">
              <span>Branch</span>
              <strong>{detail?.meta?.defaultBranch ?? repo.branch}</strong>
            </div>
            <div className="kv">
              <span>Depends on</span>
              <strong>{repo.dependsOn.join(', ') || 'none'}</strong>
            </div>

            <h3>Latest release</h3>
            {detail?.latestRelease ? (
              <a className="release-card" href={detail.latestRelease.url} target="_blank" rel="noreferrer">
                <span className="release-tag">{detail.latestRelease.tag}</span>
                <span className="release-meta">{formatDate(detail.latestRelease.publishedAt)}</span>
              </a>
            ) : (
              <div className="muted">No release yet</div>
            )}

            <h3>Tags</h3>
            <div className="chips">
              {(detail?.tags ?? []).slice(0, 12).map((tag) => (
                <span key={tag.name} className="chip mono">
                  {tag.name}
                </span>
              ))}
              {!detail?.tags?.length && <span className="muted">none</span>}
            </div>

            {step?.error && <div className="alert error">{step.error}</div>}
          </>
        )}

        {tab === 'builds' && (
          <div className="builds">
            {repo.workflows.map((spec) => {
              const fromRun = step?.runs.filter((run) => run.file === spec.file) ?? [];
              const latest = detail?.workflows?.find((item) => item.spec.file === spec.file);
              return (
                <div className="build-row" key={spec.file}>
                  <div className="build-name">
                    {latest?.info ? (
                      <a className="mono build-file" href={latest.info.htmlUrl} target="_blank" rel="noreferrer">
                        {spec.file}
                      </a>
                    ) : (
                      <span className="mono">{spec.file}</span>
                    )}
                    {spec.optional && <span className="chip small">optional</span>}
                  </div>
                  <div className="build-meta">
                    {fromRun.length > 0
                      ? fromRun.map((run) => (
                          <span key={run.runId} className="run-line">
                            <span
                              className={`badge status-${run.status === 'completed' ? (run.conclusion ?? 'success') : run.status}`}
                            >
                              {run.conclusion ?? run.status}
                            </span>
                            <span className="mono">#{run.runId}</span>
                            <a href={run.htmlUrl} target="_blank" rel="noreferrer">
                              Actions ↗
                            </a>
                          </span>
                        ))
                      : latest?.latestRun && (
                          <span className="run-line">
                            <span
                              className={`badge status-${latest.latestRun.status === 'completed' ? (latest.latestRun.conclusion ?? 'success') : latest.latestRun.status}`}
                            >
                              {latest.latestRun.conclusion ?? latest.latestRun.status}
                            </span>
                            <span className="mono">#{latest.latestRun.id}</span>
                            <a href={latest.latestRun.htmlUrl} target="_blank" rel="noreferrer">
                              Actions ↗
                            </a>
                          </span>
                        )}
                    {!fromRun.length && !latest?.latestRun && <span className="muted">no runs</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'commits' && (
          <div className="commits">
            <div className="muted">
              Since {detail?.latestRelease?.tag ?? 'the beginning of history'}
            </div>
            {(detail?.commits ?? []).map((commit) => (
              <a key={commit.sha} className="commit" href={commit.url} target="_blank" rel="noreferrer">
                <div className="commit-title">{commit.title}</div>
                <div className="commit-meta">
                  <span className="mono">{commit.shortSha}</span>
                  <span>@{commit.author}</span>
                  <span>{formatDate(commit.date)}</span>
                </div>
              </a>
            ))}
            {!detail?.commits?.length && <div className="muted">No commits found</div>}
          </div>
        )}

        {tab === 'config' && <pre className="config-view">{stringify(repo)}</pre>}
      </div>

      <RepoEditor open={editorOpen} repoKey={repoKey} onClose={() => setEditorOpen(false)} />
      <PublishModal
        open={publishMode !== null}
        mode={publishMode ?? 'tag'}
        repoKey={repoKey}
        onClose={() => setPublishMode(null)}
      />
    </aside>
  );
}
