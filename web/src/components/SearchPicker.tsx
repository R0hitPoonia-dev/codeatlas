// Dropdown with a search box for picking one item out of a long list (functions, endpoints).
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

export interface PickerOption {
  id: string;
  label: string;
  /** Secondary text shown under the label (service, file:line, kind). */
  hint?: string;
}

interface Props {
  label: string;
  options: PickerOption[];
  value?: string;
  onChange: (id: string) => void;
  placeholder?: string;
}

const MAX_SHOWN = 300;

/**
 * Every word of the query must appear in the label or hint (any order, case-insensitive).
 * Best matches first: a name segment starting with the word ("place" -> OrderService.place),
 * then the name containing it, then parameter types, then only the hint (service / file).
 */
export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  const scored: { o: PickerOption; score: number; i: number }[] = [];
  options.forEach((o, i) => {
    const label = o.label.toLowerCase();
    const paren = label.indexOf("(");
    const name = paren >= 0 ? label.slice(0, paren) : label;
    const hint = (o.hint ?? "").toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name.split(/[.\s/]+/).some((seg) => seg.startsWith(w))) score += 0;
      else if (name.includes(w)) score += 1;
      else if (label.includes(w)) score += 2;
      else if (hint.includes(w)) score += 3;
      else return; // a word matches nowhere
    }
    scored.push({ o, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.o);
}

export default function SearchPicker({ label, options, value, onChange, placeholder = "Search…" }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const current = options.find((o) => o.id === value);
  const matches = useMemo(() => filterOptions(options, query), [options, query]);
  const shown = matches.slice(0, MAX_SHOWN);

  // close when clicking anywhere else
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // opening: focus the search box and highlight the current choice
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const i = shown.findIndex((o) => o.id === value);
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // keep the highlighted row in view
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (o: PickerOption | undefined) => {
    if (!o) return;
    onChange(o.id);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="search-picker" ref={root}>
      <span className="search-picker-label">{label}</span>
      <button type="button" className="search-picker-field" aria-haspopup="listbox" aria-expanded={open}
        title={current?.label} onClick={() => setOpen((o) => !o)}>
        <span className="search-picker-value">{current ? current.label : <span className="muted">Choose…</span>}</span>
        <span aria-hidden className="search-picker-caret">▾</span>
      </button>
      {open && (
        <div className="search-picker-panel" role="dialog" aria-label={`Choose ${label.toLowerCase()}`}>
          <form className="search-picker-search" onSubmit={(e) => { e.preventDefault(); pick(shown[active]); }}>
            <input ref={input} type="search" value={query} placeholder={placeholder} aria-label={`Search ${label.toLowerCase()}`}
              role="combobox" aria-controls={listId} aria-expanded aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
            <button type="submit" disabled={!shown.length}>Search</button>
          </form>
          <div className="search-picker-count muted small">
            {matches.length === options.length ? `${options.length} items` : `${matches.length} of ${options.length} match`}
            {matches.length > MAX_SHOWN && ` — showing the first ${MAX_SHOWN}, refine the search`}
          </div>
          <ul className="search-picker-list" role="listbox" id={listId} ref={list}>
            {shown.map((o, i) => (
              <li key={o.id} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={o.id === value}
                className={`${i === active ? "active" : ""}${o.id === value ? " current" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
                <div className="search-picker-option">{o.label}</div>
                {o.hint && <div className="search-picker-hint">{o.hint}</div>}
              </li>
            ))}
            {!shown.length && <li className="search-picker-empty muted">No matches for “{query}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
