// The outline beside every diagram: the same diagram read top to bottom. For a program: how
// it is started, its entry point, then each part in the order data moves through it, with
// what it receives, what it hands on and (folded) the steps it takes. Other tabs list their
// boxes the same way (services, packages, functions, tables, participants).
import type { Outline, PartLink } from "../graph/reading";

export default function ProgramOutline({ outline, selected, onSelect }: {
  outline: Outline;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const terms = outline.controlTerms ?? ["started by", "starts"];
  return (
    <aside className="outline" aria-label="Outline">
      <div className="outline-head">
        <h3>{outline.title}</h3>
        {outline.launch && <div className="small"><code>{outline.launch}</code></div>}
        {outline.entry && <div className="small muted">entry point <code>{outline.entry}</code></div>}
      </div>
      <ol className="outline-parts">
        {outline.parts.map((p) => {
          const startedBy = p.inputs.filter((l) => l.control);
          const starts = p.outputs.filter((l) => l.control);
          const ins = p.inputs.filter((l) => !l.control);
          const outs = p.outputs.filter((l) => !l.control);
          return (
            <li key={p.id} className={selected === p.ref ? "on" : undefined}>
              <button className="link outline-title" onClick={() => onSelect(p.ref)}>
                <span className="outline-num">{p.n}</span>{p.title}
              </button>
              {(p.kind || p.code) && (
                <div className="small muted">{p.kind}{p.kind && p.code ? " · " : ""}{p.code && <code>{p.code}</code>}</div>
              )}
              {p.doc && <div className="outline-doc small">“{p.doc}”</div>}
              <dl className="outline-io small">
                {startedBy.length > 0 && <Links term={terms[0]} arrow="←" links={startedBy} onSelect={onSelect} />}
                {ins.length > 0 && <Links term="in" arrow="←" links={ins} onSelect={onSelect} />}
                {outs.length > 0 && <Links term="out" arrow="→" links={outs} onSelect={onSelect} />}
                {starts.length > 0 && <Links term={terms[1]} arrow="→" links={starts} onSelect={onSelect} />}
              </dl>
              {p.steps.length > 0 && (
                <details className="outline-steps small">
                  <summary>{outline.stepsLabel ?? "what it does"} ({p.steps.length})</summary>
                  <ul>
                    {p.steps.map((r, i) => (
                      <li key={i} className={r.muted ? "muted" : undefined}>
                        <span className="outline-mark">{r.marker ?? ""}</span><code>{r.text}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/** "in  ConnectorPacket ← Socket clients (TCP :5001)", "out  byte[] → fills (kafka topic)". */
function Links({ term, arrow, links, onSelect }: { term: string; arrow: string; links: PartLink[]; onSelect: (id: string) => void }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>
        <ul>
          {links.map((l, i) => (
            <li key={i}>
              {l.control ? null : <code className="outline-data">{l.data}</code>}
              {!l.control && " "}
              {arrow}{" "}
              {l.ref ? <button className="link" onClick={() => onSelect(l.ref!)}>{l.label}</button> : l.label}
              {l.control && l.data && <span className="muted"> · {l.data}</span>}
              {!l.control && l.via && <span className="muted"> · {l.via}</span>}
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}
