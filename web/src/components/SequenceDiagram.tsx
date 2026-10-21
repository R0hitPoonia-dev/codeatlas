// SVG renderer for sequence diagrams: service boxes, lifelines, messages and
// alt / opt / loop / critical fragments with their sections.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { focusOn } from "../graph/focus";
import { collapseServices, Participant, Sequence, SeqItem } from "../graph/sequence";

const CHAR = 6.6; // px per character at 11.5px
const TOP = 34; // participant header top (group labels above)
const HEAD_H = 34;
const ROW = 30;

function textWidth(s: string) {
  return s.length * CHAR;
}

interface Props {
  seq: Sequence;
  selected?: string;
  onSelect: (ref: string | undefined) => void;
}

export default function SequenceDiagram({ seq: full, selected, onSelect }: Props) {
  // service boxes collapse into a single lifeline (click the box label / the collapsed lifeline)
  const [collapsedFor, setCollapsedFor] = useState<{ seq: Sequence; services: Set<string> }>();
  const collapsed = collapsedFor?.seq === full ? collapsedFor.services : new Set<string>();
  const toggleService = (g: string) => {
    const next = new Set(collapsed);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setCollapsedFor({ seq: full, services: next });
  };
  const seq = useMemo(() => collapseServices(full, collapsed), [full, collapsed]);
  const layout = useMemo(() => columns(seq), [seq]);
  // Scale down to the pane width when that keeps text readable (at most 2x smaller).
  const box = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [zoom, setZoom] = useState<number | "fit" | undefined>(); // undefined: auto
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth));
    ro.observe(el);
    setPaneWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { x, widths } = layout;
  const index = new Map(seq.participants.map((p, i) => [p.id, i]));

  // Focus: the clicked participant (or both ends of the clicked message), the participants on a
  // call path through it, and the messages between them; the rest dims. Returns are not paths.
  const focus = useMemo(() => {
    if (!selected) return undefined;
    const msgs: Extract<SeqItem, { k: "msg" }>[] = [];
    const walk = (its: SeqItem[]) => its.forEach((it) => (it.k === "msg" ? msgs.push(it) : it.k === "frag" ? it.sections.forEach((s) => walk(s.items)) : undefined));
    walk(seq.items);
    const own = seq.participants.filter((p) => p.ref === selected).map((p) => p.id);
    const ends = own.length ? own : [...new Set(msgs.filter((m) => m.ref === selected).flatMap((m) => [m.from, m.to]))];
    if (!ends.length) return undefined;
    const calls = msgs.filter((m) => m.style !== "return" && m.from !== m.to)
      .map((m) => ({ id: `${m.from}>${m.to}`, source: m.from, target: m.to, style: "call" as const, count: 1 }));
    const related = new Set<string>();
    const pairs = new Set<string>();
    for (const end of ends) {
      const f = focusOn(end, calls);
      f.related.forEach((r) => related.add(r));
      f.edges.forEach((e) => pairs.add(e));
    }
    ends.forEach((e) => related.delete(e));
    const lit = (m: Extract<SeqItem, { k: "msg" }>) => m.ref === selected || pairs.has(`${m.from}>${m.to}`) || pairs.has(`${m.to}>${m.from}`)
      || (m.from === m.to && (ends.includes(m.from) || related.has(m.from)));
    return { ends: new Set(ends), related, lit };
  }, [seq, selected]);
  const headClass = (id: string) => (!focus ? "" : focus.ends.has(id) ? " focus" : focus.related.has(id) ? " related" : " dimmed");
  const els: ReactNode[] = [];
  let y = TOP + HEAD_H + 26;
  let key = 0;

  const span = (items: SeqItem[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    const visit = (its: SeqItem[]) => {
      for (const it of its) {
        if (it.k === "msg") {
          for (const p of [it.from, it.to]) {
            const i = index.get(p)!;
            lo = Math.min(lo, i);
            hi = Math.max(hi, i);
          }
        } else if (it.k === "note") {
          const i = index.get(it.over)!;
          lo = Math.min(lo, i);
          hi = Math.max(hi, i);
        } else {
          it.sections.forEach((s) => visit(s.items));
        }
      }
    };
    visit(items);
    return [lo, hi];
  };

  const render = (items: SeqItem[], depth: number) => {
    for (const it of items) {
      if (it.k === "msg") {
        const x1 = x[index.get(it.from)!];
        const x2 = x[index.get(it.to)!];
        const cls = `seq-msg seq-${it.style}${it.ref && it.ref === selected ? " selected" : ""}${it.ref ? " clickable" : ""}${focus && !focus.lit(it) ? " dimmed" : ""}`;
        const click = it.ref ? () => onSelect(it.ref) : undefined;
        if (x1 === x2) {
          els.push(
            <g key={key++} className={cls} onClick={click}>
              <path d={`M ${x1} ${y} h 28 v 16 h -26`} markerEnd={`url(#seq-arrow-${it.style === "return" ? "open" : "solid"})`} />
              <text x={x1 + 34} y={y + 12}>{it.label}</text>
              <title>{lineTitle(it)}</title>
            </g>,
          );
          y += ROW + 12;
        } else {
          els.push(
            <g key={key++} className={cls} onClick={click}>
              <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -2 : 2)} y2={y}
                markerEnd={`url(#seq-arrow-${it.style === "return" || it.style === "async" ? "open" : "solid"})`} />
              <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle">{it.label}</text>
              <title>{lineTitle(it)}</title>
            </g>,
          );
          y += ROW;
        }
      } else if (it.k === "note") {
        const px = x[index.get(it.over)!];
        const w = textWidth(it.text) + 16;
        els.push(
          <g key={key++} className="seq-note">
            <rect x={px - w / 2} y={y - 12} width={w} height={22} rx={3} />
            <text x={px} y={y + 3} textAnchor="middle">{it.text}</text>
          </g>,
        );
        y += ROW + 4;
      } else {
        const [lo, hi] = span(it.sections.flatMap((s) => s.items));
        const pad = Math.max(56 - depth * 10, 14);
        const left = x[lo] - Math.max(widths[lo] / 2, 60) - pad + 40;
        const right = x[hi] + Math.max(widths[hi] / 2, 60) + pad - 40 + (lo === hi ? 40 : 0);
        const top = y - 14;
        const slot = key++;
        els.push(null); // placeholder: the frame is drawn behind its contents once its height is known
        const at = els.length - 1;
        const separators: ReactNode[] = [];
        y += 22;
        it.sections.forEach((s, i) => {
          if (i > 0) {
            separators.push(
              <g key={`sep${i}`}>
                <line className="seq-sep" x1={left} y1={y - 16} x2={right} y2={y - 16} />
                <text className="seq-guard" x={left + 8} y={y - 3}>[{s.label}]</text>
              </g>,
            );
            y += 10;
          }
          render(s.items, depth + 1);
          if (i < it.sections.length - 1) y += 8;
        });
        y += 4;
        const tab = it.type;
        const tabW = textWidth(tab) + 16;
        els[at] = (
          <g key={slot} className={`seq-frag seq-frag-${it.type}`}>
            <rect className="seq-frame" x={left} y={top} width={right - left} height={y - top} rx={3} />
            <path className="seq-tab" d={`M ${left} ${top} h ${tabW} v 12 l -6 6 h ${-tabW + 6} z`} />
            <text className="seq-tab-text" x={left + 6} y={top + 13}>{tab}</text>
            <text className="seq-guard" x={left + tabW + 6} y={top + 13}>[{it.sections[0].label}]</text>
            {separators}
          </g>
        );
        y += 14;
      }
    }
  };
  render(seq.items, 0);

  const height = y + 16;
  const width = x.length ? x[x.length - 1] + widths[widths.length - 1] / 2 + 24 : 0;
  const groups = groupSpans(seq.participants);
  const fit = paneWidth && width > paneWidth ? (paneWidth - 4) / width : 1;
  // auto: fit when that keeps text at least half size, else 100% with scrolling
  const scale = zoom === "fit" ? fit : typeof zoom === "number" ? zoom : fit >= 0.5 ? fit : 1;
  const step = (f: number) => setZoom(Math.min(2, Math.max(0.2, Math.round(scale * f * 10) / 10)));

  if (seq.empty && seq.items.length <= 1) {
    return <div ref={box} className="seq-scroll"><div className="canvas-empty muted">{seq.empty}</div></div>;
  }
  return (
    <div className="seq-scroll" ref={box}>
      <div className="seq-zoom">
        <button className="secondary" onClick={() => step(1 / 1.25)} aria-label="Zoom out">−</button>
        <button className="secondary" onClick={() => setZoom("fit")}>Fit</button>
        <button className="secondary" onClick={() => setZoom(1)}>100%</button>
        <button className="secondary" onClick={() => step(1.25)} aria-label="Zoom in">+</button>
      </div>
      {seq.truncated && <p className="muted small pad">Showing the first 250 messages. Lower the depth to see the rest.</p>}
      <svg className="seq" width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`}
        role="img" aria-label="Sequence diagram">
        <defs>
          <marker id="seq-arrow-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="seq-arrow" />
          </marker>
          <marker id="seq-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10" className="seq-arrow-open" />
          </marker>
        </defs>
        {groups.map((g) => {
          const left = x[g.from] - widths[g.from] / 2 - 10;
          const right = x[g.to] + widths[g.to] / 2 + 10;
          return (
            <g key={`${g.name}${g.from}`} className="seq-group">
              <rect x={left} y={6} width={right - left} height={height - 10} rx={6} />
              <text x={left + 8} y={22} className="seq-group-label" onClick={() => toggleService(g.name)}>
                {collapsed.has(g.name) ? "▸ " : "▾ "}{g.name}
                <title>{collapsed.has(g.name) ? "Expand into its classes" : "Collapse into one lifeline"}</title>
              </text>
            </g>
          );
        })}
        {seq.participants.map((p, i) => (
          <line key={`life${p.id}`} className={`seq-life${headClass(p.id)}`} x1={x[i]} y1={TOP + HEAD_H} x2={x[i]} y2={height - 8} />
        ))}
        {els}
        {seq.participants.map((p, i) => (
          <g key={p.id} className={`seq-head seq-${p.kind}${p.ref || p.id.startsWith("collapsed:") ? " clickable" : ""}${p.ref && p.ref === selected ? " selected" : ""}${headClass(p.id)}`}
            onClick={p.id.startsWith("collapsed:") ? () => toggleService(p.group!) : p.ref ? () => onSelect(p.ref) : undefined}>
            <rect x={x[i] - widths[i] / 2} y={TOP} width={widths[i]} height={HEAD_H} rx={p.kind === "actor" ? 17 : 5} />
            <text x={x[i]} y={TOP + 15} textAnchor="middle" className="seq-head-title">{p.label}</text>
            <text x={x[i]} y={TOP + 28} textAnchor="middle" className="seq-head-kind">{p.kind}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function lineTitle(it: Extract<SeqItem, { k: "msg" }>) {
  return it.line ? `${it.label} (line ${it.line})` : it.label;
}

/** Column centres: wide enough for headers and for the messages between neighbours. */
function columns(seq: Sequence): { x: number[]; widths: number[] } {
  const ps = seq.participants;
  const widths = ps.map((p) => Math.max(120, Math.min(textWidth(p.label) + 26, 240)));
  const index = new Map(ps.map((p, i) => [p.id, i]));
  const gap = ps.map(() => 0); // required centre distance between i and i+1
  const visit = (items: SeqItem[]) => {
    for (const it of items) {
      if (it.k === "msg") {
        const a = index.get(it.from)!;
        const b = index.get(it.to)!;
        const need = textWidth(it.label) + 24;
        if (a === b) {
          if (a < ps.length - 1) gap[a] = Math.max(gap[a], need + 40);
        } else {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const per = need / (hi - lo);
          for (let i = lo; i < hi; i++) gap[i] = Math.max(gap[i], per);
        }
      } else if (it.k === "frag") {
        it.sections.forEach((s) => visit(s.items));
      }
    }
  };
  visit(seq.items);
  const x: number[] = [];
  ps.forEach((_, i) => {
    if (i === 0) x.push(24 + widths[0] / 2);
    else x.push(x[i - 1] + Math.max((widths[i - 1] + widths[i]) / 2 + 28, gap[i - 1]));
  });
  return { x, widths };
}

function groupSpans(ps: Participant[]): { name: string; from: number; to: number }[] {
  const out: { name: string; from: number; to: number }[] = [];
  ps.forEach((p, i) => {
    const g = p.kind === "actor" ? undefined : p.group;
    const last = out[out.length - 1];
    if (g && last && last.name === g && last.to === i - 1) last.to = i;
    else if (g) out.push({ name: g, from: i, to: i });
  });
  return out;
}
