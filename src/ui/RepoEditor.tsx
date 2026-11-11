import { useEffect, useMemo, useState } from 'react';
import { descendantKeys } from '../core/graph';
import { useApp } from '../core/store';
import type { RepoNode } from '../core/types';

interface Props {
  open: boolean;
  repoKey: string | null;
  onClose: () => void;
}

interface WorkflowDraft {
  file: string;
  ref: string;
  optional: boolean;
}

export function RepoEditor({ open, repoKey, onClose }: Props) {
  const config = useApp((s) => s.config);
  const configErrors = useApp((s) => s.configErrors);
  const availableWorkflows = useApp((s) => s.availableWorkflows);
  const upsertRepo = useApp((s) => s.upsertRepo);
  const removeRepo = useApp((s) => s.removeRepo);

  const existing = useMemo(
    () => config?.repos.find((repo) => repo.key === repoKey) ?? null,
    [config, repoKey],
  );

  const [key, setKey] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('main');
  const [workflows, setWorkflows] = useState<WorkflowDraft[]>([
    { file: 'build-image.yml', ref: '', optional: false },
  ]);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setKey(existing.key);
      setSlug(`${existing.repo.owner}/${existing.repo.name}`);
      setDescription(existing.description);
      setBranch(existing.branch);
      setWorkflows(
        existing.workflows.map((workflow) => ({
          file: workflow.file,
          ref: workflow.ref ?? '',
          optional: Boolean(workflow.optional),
        })),
      );
      setDependsOn(existing.dependsOn);
    } else {
      setKey('');
      setSlug('');
      setDescription('');
      setBranch(config?.branch ?? 'main');
      setWorkflows([{ file: 'build-image.yml', ref: '', optional: false }]);
      setDependsOn([]);
    }
    setErrors([]);
  }, [open, existing, config]);

  if (!open) return null;

  const blocked = repoKey && config ? descendantKeys(repoKey, config.repos) : new Set<string>();
  const candidates = (config?.repos ?? []).filter(
    (repo) => repo.key !== repoKey && !blocked.has(repo.key),
  );
  const dependents = (config?.repos ?? []).filter((repo) => repo.dependsOn.includes(repoKey ?? ''));
  const workflowOptions = repoKey ? availableWorkflows[repoKey] ?? [] : [];

  const updateWorkflow = (index: number, patch: Partial<WorkflowDraft>) => {
    setWorkflows((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const save = () => {
    const problems: string[] = [];
    const trimmedKey = key.trim();
    const [owner, name] = slug.trim().split('/');

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedKey)) {
      problems.push('Key must contain letters, digits, dots, dashes or underscores');
    }
    if ((config?.repos ?? []).some((repo) => repo.key === trimmedKey && repo.key !== repoKey)) {
      problems.push(`Key ${trimmedKey} is already used`);
    }
    if (!owner || !name) problems.push('Repository must be owner/name');
    if (!workflows.some((workflow) => workflow.file.trim())) {
      problems.push('At least one workflow file is required');
    }

    if (problems.length) {
      setErrors(problems);
      return;
    }

    const node: RepoNode = {
      key: trimmedKey,
      provider: existing?.provider ?? config?.provider ?? 'github',
      repo: { owner, name },
      url: existing?.url ?? `https://github.com/${owner}/${name}.git`,
      description: description.trim(),
      branch: branch.trim() || 'main',
      dependsOn,
      workflows: workflows
        .filter((workflow) => workflow.file.trim())
        .map((workflow) => ({
          file: workflow.file.trim(),
          ref: workflow.ref.trim() || undefined,
          optional: workflow.optional,
        })),
      labels: existing?.labels ?? [],
    };

    if (!upsertRepo(node, repoKey ?? undefined)) {
      setErrors(useApp.getState().configErrors);
      return;
    }
    onClose();
  };

  const remove = () => {
    if (!repoKey) return;
    if (!window.confirm(`Remove ${repoKey} from the pipeline?`)) return;
    if (!removeRepo(repoKey)) {
      setErrors(useApp.getState().configErrors);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{repoKey ? `Edit ${repoKey}` : 'Add image'}</h2>
            <p className="muted">Repositories, workflows and their place in the dependency graph.</p>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="editor">
          <section className="editor-section">
            <h3>Repository</h3>
            <div className="editor-grid">
              <label className="field-block">
                Key
                <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="api-image" />
              </label>
              <label className="field-block">
                Repository
                <input
                  className="mono"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="acme/api-image"
                />
              </label>
              <label className="field-block">
                Branch
                <input
                  className="mono"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="main"
                />
              </label>
              <label className="field-block">
                Description
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Business API image"
                />
              </label>
            </div>
          </section>

          <section className="editor-section">
            <h3>Workflows</h3>
            <div className="workflow-list">
              {workflows.map((workflow, index) => (
                <div className="workflow-row" key={index}>
                  <input
                    className="mono"
                    list={`workflow-files-${index}`}
                    value={workflow.file}
                    onChange={(event) => updateWorkflow(index, { file: event.target.value })}
                    placeholder="build-image.yml"
                  />
                  <datalist id={`workflow-files-${index}`}>
                    {workflowOptions.map((option) => (
                      <option key={option.id} value={option.file}>
                        {option.name}
                      </option>
                    ))}
                  </datalist>
                  <input
                    className="mono"
                    value={workflow.ref}
                    onChange={(event) => updateWorkflow(index, { ref: event.target.value })}
                    placeholder="ref (optional)"
                  />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={workflow.optional}
                      onChange={(event) => updateWorkflow(index, { optional: event.target.checked })}
                    />
                    optional
                  </label>
                  <button
                    className="icon"
                    onClick={() => setWorkflows((list) => list.filter((_, i) => i !== index))}
                    title="Remove workflow"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button onClick={() => setWorkflows((list) => [...list, { file: '', ref: '', optional: false }])}>
              + Add workflow
            </button>
          </section>

          <section className="editor-section">
            <h3>Depends on</h3>
            {candidates.length ? (
              <div className="dep-list">
                {candidates.map((repo) => (
                  <label className="check" key={repo.key}>
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(repo.key)}
                      onChange={(event) =>
                        setDependsOn((list) =>
                          event.target.checked
                            ? [...list, repo.key]
                            : list.filter((item) => item !== repo.key),
                        )
                      }
                    />
                    {repo.key}
                    <span className="muted mono">
                      {repo.repo.owner}/{repo.repo.name}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="muted">No other repositories available.</p>
            )}
            {dependents.length > 0 && (
              <p className="muted">Required by: {dependents.map((repo) => repo.key).join(', ')}</p>
            )}
          </section>

          {errors.length > 0 && (
            <div className="alert error">
              <ul>
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {configErrors.length > 0 && !errors.length && (
            <div className="alert warn">{configErrors[0]}</div>
          )}
        </div>

        <footer className="modal-foot">
          {repoKey && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            {repoKey ? 'Save changes' : 'Add image'}
          </button>
        </footer>
      </div>
    </div>
  );
}
