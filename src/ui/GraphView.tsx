
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
const ROUTE_RADIUS = 10;
const TRACK_STEP = 14;
const LANE_MARGIN = 20;
const OVERLAP_MARGIN = 4;
const PORT_STEP = 12;
const PORT_MARGIN = 24;
 
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
 
interface Jog {
  edge: string;
  lane: number;
  y1: number;
  y2: number;
  lo: number;
  hi: number;
  x?: number;
}
 
function assignTracks(jogs: Jog[], laneLeft: number) {
  const center = laneLeft + GAP_X / 2;
  const moving = jogs.filter((j) => j.hi - j.lo > 0.5);
  for (const jog of jogs) jog.x = center;
  if (!moving.length) return;
 
  const inside = (y: number, j: Jog) => y > j.lo + 0.5 && y < j.hi - 0.5;
 
  const conflict = (a: Jog, b: Jog) =>
    (a.lo < b.hi + OVERLAP_MARGIN && b.lo < a.hi + OVERLAP_MARGIN) ||
    Math.abs(a.y2 - b.y1) < 1 ||
    Math.abs(b.y2 - a.y1) < 1;
 
  const cost = (a: Jog, b: Jog) =>
    (inside(a.y2, b) ? 1 : 0) +
    (inside(b.y1, a) ? 1 : 0) +
    (Math.abs(a.y2 - b.y1) < 1 ? 10 : 0);
 
  const score = new Map<Jog, number>();
  for (const a of moving) {
    let s = 0;
    for (const b of moving) {
      if (a !== b && conflict(a, b)) s += cost(a, b) - cost(b, a);
    }
    score.set(a, s);
  }
 
  const order = [...moving].sort(
    (a, b) =>
      (score.get(a) ?? 0) - (score.get(b) ?? 0) || a.lo - b.lo || a.edge.localeCompare(b.edge),
  );
 
  const track = new Map<Jog, number>();
  let tracks = 0;
  order.forEach((jog, index) => {
    let t = 0;
    for (let k = 0; k < index; k += 1) {
      const other = order[k];
      if (conflict(jog, other)) t = Math.max(t, (track.get(other) ?? 0) + 1);
    }
    track.set(jog, t);
    tracks = Math.max(tracks, t + 1);
  });
 
  const step = tracks > 1 ? Math.min(TRACK_STEP, (GAP_X - LANE_MARGIN * 2) / (tracks - 1)) : 0;
  for (const jog of moving) {
    jog.x = center + ((track.get(jog) ?? 0) - (tracks - 1) / 2) * step;
  }
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
 
interface PortItem {
  key: string;
  other: string;
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
 
    const chains = new Map<string, string[]>();
    for (const repo of repos) {
      for (const dep of repo.dependsOn) {
        const from = levelOf.get(dep);
        const to = levelOf.get(repo.key);
        if (from === undefined || to === undefined || to <= from) continue;
        const edgeKey = `${dep}->${repo.key}`;
        if (chains.has(edgeKey)) continue;
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
 
    const xs: Record<string, number> = {};
    const ys: Record<string, number> = {};
    levels.forEach((level, column) => {
      for (const id of level) {
        xs[id] = column * (NODE_W + GAP_X);
        ys[id] = centers[id] - heights(id) / 2 - minTop;
      }
    });
 
    const centerOf = (id: string) => (ys[id] ?? 0) + heights(id) / 2;
 
    const edgeMap = new Map<string, EdgeRef>();
    for (const repo of repos) {
      for (const dep of repo.dependsOn) {
        if (!levelOf.has(dep) || !levelOf.has(repo.key)) continue;
        const key = `${dep}->${repo.key}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { key, from: dep, to: repo.key });
      }
    }
    const edgeList = [...edgeMap.values()];
 
    const sequences = new Map<string, string[]>();
    for (const edge of edgeList) {
      const from = levelOf.get(edge.from) ?? 0;
      const to = levelOf.get(edge.to) ?? 0;
      if (to <= from) continue;
      sequences.set(edge.key, [edge.from, ...(chains.get(edge.key) ?? []), edge.to]);
    }
 
    const outgoing = new Map<string, PortItem[]>();
    const incoming = new Map<string, PortItem[]>();
    const pushPort = (map: Map<string, PortItem[]>, id: string, item: PortItem) => {
      const list = map.get(id);
      if (list) list.push(item);
      else map.set(id, [item]);
    };
    for (const [key, seq] of sequences) {
      pushPort(outgoing, seq[0], { key, other: seq[1] });
      pushPort(incoming, seq[seq.length - 1], { key, other: seq[seq.length - 2] });
    }
 
    const outY = new Map<string, number>();
    const inY = new Map<string, number>();
    const assignPorts = (groups: Map<string, PortItem[]>, target: Map<string, number>) => {
      for (const [id, items] of groups) {
        items.sort(
          (a, b) => centerOf(a.other) - centerOf(b.other) || a.key.localeCompare(b.key),
        );
        const count = items.length;
        const step =
          count > 1 ? Math.min(PORT_STEP, (NODE_H - PORT_MARGIN * 2) / (count - 1)) : 0;
        items.forEach((item, index) => {
          target.set(item.key, centerOf(id) + (index - (count - 1) / 2) * step);
        });
      }
    };
    assignPorts(outgoing, outY);
    assignPorts(incoming, inY);
 
    const jogsByLane = new Map<number, Jog[]>();
    const jogOf = new Map<string, Jog>();
    for (const [key, seq] of sequences) {
      const from = levelOf.get(seq[0]) ?? 0;
      for (let i = 0; i < seq.length - 1; i += 1) {
        const laneIndex = from + i;
        const y1 = i === 0 ? (outY.get(key) ?? centerOf(seq[0])) : centerOf(seq[i]);
        const y2 =
          i === seq.length - 2 ? (inY.get(key) ?? centerOf(seq[i + 1])) : centerOf(seq[i + 1]);
        const jog: Jog = {
          edge: key,
          lane: laneIndex,
          y1,
          y2,
          lo: Math.min(y1, y2),
          hi: Math.max(y1, y2),
        };
        jogOf.set(`${key}@${laneIndex}`, jog);
        const list = jogsByLane.get(laneIndex);
        if (list) list.push(jog);
        else jogsByLane.set(laneIndex, [jog]);
      }
    }
 
    for (const [laneIndex, jogs] of jogsByLane) {
      assignTracks(jogs, laneIndex * (NODE_W + GAP_X) + NODE_W);
    }
 
    const edges: EdgePath[] = edgeList.map((edge) => {
      const seq = sequences.get(edge.key);
      if (!seq) {
        const points = [
          { x: xs[edge.from] + NODE_W, y: centerOf(edge.from) },
          { x: xs[edge.to], y: centerOf(edge.to) },
        ];
        return { key: edge.key, from: edge.from, to: edge.to, d: route(points) };
      }
      const from = levelOf.get(edge.from) ?? 0;
      const points: Array<{ x: number; y: number }> = [
        { x: xs[edge.from] + NODE_W, y: outY.get(edge.key) ?? centerOf(edge.from) },
      ];
      for (let i = 0; i < seq.length - 1; i += 1) {
        const jog = jogOf.get(`${edge.key}@${from + i}`);
        if (jog && jog.x !== undefined) {
          points.push({ x: jog.x, y: jog.y1 }, { x: jog.x, y: jog.y2 });
        }
      }
      points.push({ x: xs[edge.to], y: inY.get(edge.key) ?? centerOf(edge.to) });
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
 