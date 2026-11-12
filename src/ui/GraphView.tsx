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
const ROUTE_RADIUS = 12;

function route(points: Array<{ x: number; y: number }>): string {
  const clean = points.filter(
    (point, index) =>
      index === 0 ||
      Math.abs(point.x - points[index - 1].x) > 0.5 ||
      Math.abs(point.y - points[index - 1].y) > 0.5,
  );
  if (!clean.length) return '';
  let d = `M ${clean[0].x} ${clean[0].y}`;
  for (let index = 1; index < clean.length; index += 1) {
    const previous = clean[index - 1];
    const current = clean[index];
    const next = clean[index + 1];
    if (!next) {
      d += ` L ${current.x} ${current.y}`;
      break;
    }
    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(ROUTE_RADIUS, inLength / 2, outLength / 2);
    const inX = current.x - ((current.x - previous.x) / inLength) * radius;
    const inY = current.y - ((current.y - previous.y) / inLength) * radius;
    const outX = current.x + ((next.x - current.x) / outLength) * radius;
    const outY = current.y + ((next.y - current.y) / outLength) * radius;
    d += ` L ${inX} ${inY} Q ${current.x} ${current.y} ${outX} ${outY}`;
  }
  return d;
}

interface Props {
  repos: RepoNode[];
  plan: PlanState | null;
  baseline: Record<string, RepoBaseline>;
  selected: string | null;
  onSelect: (key: string) => void;
}

interface EdgePath {
  key: string;
  from: string;
  to: string;
  d: string;
}

interface EdgeRef {
  key: string;
  from: string;
  to: string;
}

interface Layout {
  xs: Record<string, number>;
  ys: Record<string, number>;
  width: number;
  height: number;
  edges: EdgePath[];
}

export function GraphView({ repos, plan, baseline, selected, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 560 });
  const [view, setView] = useState({ x: PADDING, y: PADDING, k: 1 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const layout = useMemo<Layout>(() => {
    const graph = buildGraph(repos);
    const levelOf = new Map<string, number>();
    graph.levels.forEach((level, column) => level.forEach((key) => levelOf.set(key, column)));

    const levels = graph.levels.map((level) => [...level]);
    const virtualIds = new Set<string>();
    const parentsOf = new Map<string, string[]>();
    const childrenOf = new Map<string, string[]>();
    const addParent = (child: string, parent: string) => {
      const list = parentsOf.get(child);
      if (list) list.push(parent);
      else parentsOf.set(child, [parent]);
      const kids = childrenOf.get(parent);
      if (kids) kids.push(child);
      else childrenOf.set(parent, [child]);
    };

    // Long edges hop through every column they skip so they never cut across unrelated cards.
    const chains = new Map<string, string[]>();
    for (const repo of repos) {
      for (const dep of repo.dependsOn) {
        const from = levelOf.get(dep);
        const to = levelOf.get(repo.key);
        if (from === undefined || to === undefined || to <= from) continue;
        const edgeKey = `${dep}->${repo.key}`;
        const virtuals: string[] = [];
        let previous = dep;
        for (let column = from + 1; column < to; column += 1) {
          const id = `${edgeKey}#${column}`;
          virtualIds.add(id);
          levels[column].push(id);
          virtuals.push(id);
          addParent(id, previous);
          previous = id;
        }
        addParent(repo.key, previous);
        chains.set(edgeKey, virtuals);
      }
    }

    const heights = (id: string) => (virtualIds.has(id) ? 0 : NODE_H);
    const gaps = (id: string) => (virtualIds.has(id) ? 13 : GAP_Y);
    const centers: Record<string, number> = {};

    const compact = (level: string[]) => {
      const sorted = [...level].sort(
        (a, b) => (centers[a] ?? 0) - (centers[b] ?? 0) || a.localeCompare(b),
      );
      let previous = Number.NEGATIVE_INFINITY;
      let previousHeight = 0;
      for (const id of sorted) {
        const height = heights(id);
        const floor = previous + previousHeight / 2 + gaps(id) + height / 2;
        centers[id] = Math.max(centers[id] ?? floor, floor);
        previous = centers[id];
        previousHeight = height;
      }
    };

    levels.forEach((level) => {
      level.forEach((id, index) => {
        const parents = (parentsOf.get(id) ?? []).filter((parent) => centers[parent] !== undefined);
        centers[id] = parents.length
          ? parents.reduce((sum, parent) => sum + centers[parent], 0) / parents.length
          : index * (NODE_H + GAP_Y) + NODE_H / 2;
      });
      compact(level);
    });

    // Center every node over its children so each fork opens symmetrically.
    for (let pass = 0; pass < 4; pass += 1) {
      for (let column = levels.length - 1; column >= 0; column -= 1) {
        for (const id of levels[column]) {
          const children = childrenOf.get(id) ?? [];
          if (!children.length) continue;
          centers[id] = children.reduce((sum, child) => sum + centers[child], 0) / children.length;
        }
        compact(levels[column]);
      }
    }

    let minTop = Number.POSITIVE_INFINITY;
    let maxBottom = 0;
    for (const id of Object.keys(centers)) {
      const half = heights(id) / 2;
      minTop = Math.min(minTop, centers[id] - half);
      maxBottom = Math.max(maxBottom, centers[id] + half);
    }
    if (!Number.isFinite(minTop)) minTop = 0;

    const lane = (gap: number) => gap * (NODE_W + GAP_X) + NODE_W + GAP_X / 2;

    const xs: Record<string, number> = {};
    const ys: Record<string, number> = {};
    levels.forEach((level, column) => {
      for (const id of level) {
        // Virtual waypoints sit in the free lane between two columns.
        xs[id] = virtualIds.has(id) ? lane(column - 1) : column * (NODE_W + GAP_X);
        ys[id] = centers[id] - heights(id) / 2 - minTop;
      }
    });

    const centerOf = (id: string) => (ys[id] ?? 0) + heights(id) / 2;

    const edgeList: EdgeRef[] = repos.flatMap((repo) =>
      repo.dependsOn
        .filter((dep) => levelOf.has(dep) && levelOf.has(repo.key))
        .map((dep) => ({ key: `${dep}->${repo.key}`, from: dep, to: repo.key })),
    );

    const edges = edgeList.map((edge) => {
      const toLevel = levelOf.get(edge.to) ?? 0;
      const points: Array<{ x: number; y: number }> = [];
      let currentY = centerOf(edge.from);
      points.push({ x: xs[edge.from] + NODE_W, y: currentY });
      for (const id of chains.get(edge.key) ?? []) {
        points.push({ x: xs[id], y: currentY });
        currentY = centerOf(id);
        points.push({ x: xs[id], y: currentY });
      }
      const lastLane = lane(toLevel - 1);
      const targetY = centerOf(edge.to);
      points.push({ x: lastLane, y: currentY });
      points.push({ x: lastLane, y: targetY });
      points.push({ x: xs[edge.to], y: targetY });
      return { key: edge.key, from: edge.from, to: edge.to, d: route(points) };
    });

    const width = Math.max(NODE_W, levels.length * (NODE_W + GAP_X) - GAP_X);
    return { xs, ys, width, height: Math.max(NODE_H, maxBottom - minTop), edges };
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
    if ((event.target as HTMLElement).closest('.node, .graph-controls')) return;
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

  const edges = layout.edges;

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
            const status = statusOf(edge.to);
            const dim = related && !(related.has(edge.from) && related.has(edge.to));
            return (
              <path
                key={edge.key}
                d={edge.d}
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
