import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { buildGraph, relatedKeys } from '../core/graph';
import { statusText } from '../core/types';
import type { BuildStatus, PlanState, RepoBaseline, RepoNode } from '../core/types';

const NODE_W = 252;
const NODE_H = 112;
const GAP_X = 150;
const GAP_Y = 26;
const PADDING = 40;

interface Props {
  repos: RepoNode[];
  plan: PlanState | null;
  baseline: Record<string, RepoBaseline>;
  selected: string | null;
  onSelect: (key: string) => void;
}

interface Layout {
  xs: Record<string, number>;
  ys: Record<string, number>;
  width: number;
  height: number;
}

export function GraphView({ repos, plan, baseline, selected, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 560 });
  const [view, setView] = useState({ x: PADDING, y: PADDING, k: 1 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const layout = useMemo<Layout>(() => {
    const graph = buildGraph(repos);
    const xs: Record<string, number> = {};
    const ys: Record<string, number> = {};
    const rows = Math.max(1, ...graph.levels.map((level) => level.length));
    const height = rows * (NODE_H + GAP_Y) - GAP_Y;

    graph.levels.forEach((level, column) => {
      const columnHeight = level.length * (NODE_H + GAP_Y) - GAP_Y;
      level.forEach((key, row) => {
        xs[key] = column * (NODE_W + GAP_X);
        ys[key] = (height - columnHeight) / 2 + row * (NODE_H + GAP_Y);
      });
    });

    const width = Math.max(NODE_W, graph.levels.length * (NODE_W + GAP_X) - GAP_X);
    return { xs, ys, width, height };
  }, [repos]);

  const fit = useCallback(() => {
    const scale = Math.min(
      1,
      (size.w - PADDING * 2) / Math.max(layout.width, 1),
      (size.h - PADDING * 2) / Math.max(layout.height, 1),
    );
    const k = Math.max(0.2, scale);
    setView({
      k,
      x: (size.w - layout.width * k) / 2,
      y: (size.h - layout.height * k) / 2,
    });
  }, [layout.width, layout.height, size.w, size.h]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    setSize({ w: rect.width, h: rect.height });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      setView((current) => {
        const k = Math.min(2, Math.max(0.2, current.k * (event.deltaY < 0 ? 1.08 : 0.92)));
        return {
          k,
          x: mx - ((mx - current.x) * k) / current.k,
          y: my - ((my - current.y) * k) / current.k,
        };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const related = useMemo(
    () => (selected ? relatedKeys(selected, repos) : null),
    [selected, repos],
  );

  const statusOf = (key: string): BuildStatus => {
    const step = plan?.steps[key];
    if (step && step.status !== 'idle') return step.status;
    return baseline[key]?.build ?? 'idle';
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.node')) return;
    drag.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    setView((v) => ({
      ...v,
      x: current.x + (event.clientX - current.px),
      y: current.y + (event.clientY - current.py),
    }));
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const edges = repos.flatMap((repo) =>
    repo.dependsOn.map((dep) => ({ from: dep, to: repo.key })),
  );

  const dimClass = (key: string) => (related && !related.has(key) ? ' dim' : '');

  return (
    <div
      className="graph"
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={fit}
    >
      <div className="graph-controls">
        <button onClick={() => setView((v) => ({ ...v, k: Math.min(2, v.k * 1.15) }))}>+</button>
        <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.15) }))}>−</button>
        <button onClick={fit}>Fit</button>
      </div>

      <div
        className="graph-inner"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          width: layout.width,
          height: layout.height,
        }}
      >
        <svg
          className="edges"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          {edges.map((edge) => {
            const x1 = (layout.xs[edge.from] ?? 0) + NODE_W;
            const y1 = (layout.ys[edge.from] ?? 0) + NODE_H / 2;
            const x2 = layout.xs[edge.to] ?? 0;
            const y2 = (layout.ys[edge.to] ?? 0) + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            const status = statusOf(edge.to);
            const dim = related && !(related.has(edge.from) && related.has(edge.to));
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                className={`edge status-${status}${dim ? ' dim' : ''}`}
              />
            );
          })}
        </svg>

        {repos.map((repo) => {
          const status = statusOf(repo.key);
          const tagName = baseline[repo.key]?.tag;
          const classes = [
            'node',
            `status-${status}`,
            repo.key === selected ? 'selected' : '',
            dimClass(repo.key),
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              type="button"
              key={repo.key}
              className={classes}
              style={{
                left: layout.xs[repo.key],
                top: layout.ys[repo.key],
                width: NODE_W,
                height: NODE_H,
              }}
              onClick={() => onSelect(repo.key)}
            >
              <div className="node-head">
                <span className="node-dot" />
                <span className="node-key">{repo.key}</span>
                <span className="node-state">{statusText[status]}</span>
              </div>
              <div className="node-repo">
                {repo.repo.owner}/{repo.repo.name}
              </div>
              <div className="node-foot">
                <span>{repo.workflows.length} wf</span>
                <span>{repo.dependsOn.length} dep</span>
                <span className="node-tag">{tagName ?? '—'}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
