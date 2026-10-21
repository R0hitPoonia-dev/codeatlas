import { useEffect, useMemo, useState } from "react";
import { api, Commit, GraphEdge, GraphNode, GroupOverrides, isActive, Repo, RepoConfig, RepoGraph, Snapshot } from "../api";
import { AnalysisLog, AnalysisStatus } from "../components/Analysis";
import GraphCanvas from "../components/GraphCanvas";
import SearchPicker, { PickerOption } from "../components/SearchPicker";
import SequenceDiagram from "../components/SequenceDiagram";
import { activityView, chartableFunctions } from "../graph/activity";
import { CLASS_INFO, classifyName } from "../graph/dataclass";
import { contextDataFlow, DFD_SYSTEM, ENTRY_GROUPS, entryPoints, serviceDataFlow, systemDataFlow } from "../graph/dataflow";
import { applyOverrides, configOverrides, detailLevels, Level, mergeOverrides } from "../graph/groups";
import { sequenceToMermaid, toMermaid, ViewKind } from "../graph/mermaid";
import { activityToPlantUml, sequenceToPlantUml, toPlantUml } from "../graph/plantuml";
import { programModel, programRoots } from "../graph/program";
import ProgramOutline from "../components/ProgramOutline";
import { sequenceOf, sequenceOutline } from "../graph/sequence";
import { allLayersView, Choice, CHOICE, insideOf, LEVEL, pathTo, Scope, scopeLabel, scopeOfNode, scopeView, sameScope, withChoices } from "../graph/explore";
import { locationText, Model } from "../graph/model";
import { homeOf, OUTSIDE, SCOPE_TEXT, variablesOf, whatItDoes } from "../graph/variables";
import {
  architectureView, callableLabel, classView, componentsView, conditionLabel, deploymentView, endpoints, erView, FlowInfo, flowView,
  typeContainers, ViewModel, VNode,
} from "../graph/views";

type Tab = ViewKind | "explore" | "sequence" | "api" | "snapshots";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "explore", label: "Explore", hint: "Start at the level-0 context and go inside any box: system › service › package › class › function" },
  { id: "architecture", label: "Architecture", hint: "Services, data stores, topics and external systems, and how they talk" },
  { id: "program", label: "Program", hint: "One program as if it were a single file: its entry point, its parts in the order data moves through them, what each part does, and the data it receives and hands on" },
  { id: "dataflow", label: "Data flow", hint: "What data moves between clients, services, data stores and external systems, and how sensitive it is" },
  { id: "components", label: "Components", hint: "Packages inside one service and their dependencies" },
  { id: "classes", label: "Classes", hint: "UML class diagram for one package" },
  { id: "er", label: "Data model", hint: "Tables, columns and relationships" },
  { id: "api", label: "API", hint: "Every endpoint, its handler and what it touches" },
  { id: "flow", label: "Flow", hint: "How a request is handled: call tree down to data stores and remote calls" },
  { id: "activity", label: "Activity", hint: "UML activity diagram of one function: decisions, loops, try/catch, returns and throws" },
  { id: "sequence", label: "Sequence", hint: "Sequence diagram of a request: who calls whom, in order, with alt/opt/loop blocks" },
  { id: "deployment", label: "Deployment", hint: "Containers, Kubernetes workloads and what they run" },
  { id: "snapshots", label: "Snapshots", hint: "Analyzer uploads for this repo" },
];

export function parseWorkspaceTab(s: string | undefined): Tab {
  return TABS.some((t) => t.id === s) ? (s as Tab) : "explore";
}

export default function RepoWorkspace({ name, tab, isAdmin }: { name: string; tab: Tab; isAdmin: boolean }) {
  const [commits, setCommits] = useState<Commit[]>();
  const [commit, setCommit] = useState<string>();
  const [graph, setGraph] = useState<RepoGraph>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.commits(name).then(setCommits, (e) => setError(e.message));
  }, [name, version]);

  useEffect(() => {
    if (!commits) return;
    if (!commits.length) {
      setGraph(undefined);
      return;
    }
    setGraph(undefined);
    api.repoGraph(name, commit).then(setGraph, (e) => setError(e.message));
  }, [name, commit, commits]);

  const model = useMemo(() => (graph ? new Model(graph) : undefined), [graph]);

  // grouping edits saved for this repo (admins edit; everyone sees them)
  const [userGroups, setUserGroups] = useState<GroupOverrides>();
  useEffect(() => {
    api.groups(name).then(setUserGroups, () => setUserGroups(undefined));
  }, [name]);
  const saveGroups = async (next: GroupOverrides) => {
    setUserGroups(next); // optimistic: the diagram updates at once
    try {
      setUserGroups(await api.setGroups(name, next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const go = (t: Tab) => {
    location.hash = `#/repos/${encodeURIComponent(name)}/${t}`;
  };

  return (
    <div className="workspace">
      <div className="ws-header">
        <a href="#/">Repositories</a>
        <span className="muted">/</span>
        <h1>{name}</h1>
        {commits && commits.length > 0 && (
          <select value={commit ?? commits[0].commit} onChange={(e) => setCommit(e.target.value)} aria-label="Commit">
            {commits.map((c) => (
              <option key={c.commit} value={c.commit}>
                {c.commit.slice(0, 10)} {c.branch ? `(${c.branch})` : ""} · {c.analyzers.join(", ")}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab on" : "tab"} title={t.hint} onClick={() => go(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}
      {tab === "snapshots" ? (
        <Snapshots name={name} isAdmin={isAdmin} version={version} onAnalyzed={() => setVersion((v) => v + 1)} />
      ) : commits && commits.length === 0 ? (
        <NoSnapshots name={name} isAdmin={isAdmin} onAnalyzed={() => setVersion((v) => v + 1)} />
      ) : !model ? (
        <p className="muted pad">Loading graph…</p>
      ) : (
        <Views model={model} tab={tab} go={go} system={name} config={graph?.config} userGroups={userGroups}
          onEditGroups={isAdmin ? saveGroups : undefined} />
      )}
    </div>
  );
}

function NoSnapshots({ name, isAdmin, onAnalyzed }: { name: string; isAdmin: boolean; onAnalyzed: () => void }) {
  const [repo, setRepo] = useState<Repo>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const active = isActive(repo?.analysis);

  useEffect(() => {
    api.repo(name).then(setRepo, (e) => setError(e.message));
  }, [name, version]);

  // Follow a running analysis; show the diagrams once it has stored something.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setVersion((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => {
    if (repo?.lastCommit) onAnalyzed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.lastCommit]);

  async function analyze() {
    setError("");
    try {
      await api.startAnalysis(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setVersion((v) => v + 1);
  }

  return (
    <div className="card pad">
      {repo?.analysis ? (
        <>
          <p><AnalysisStatus repo={repo} /></p>
          <AnalysisLog name={name} active={active} />
        </>
      ) : (
        <p>No analysis uploaded yet.</p>
      )}
      {isAdmin && repo && !active && (
        repo.url ? (
          <p><button onClick={analyze}>{repo.analysis ? "Try again" : "Analyze now"}</button>{" "}
            <span className="muted small">Clones {repo.url} on the server and runs the analyzers.</span></p>
        ) : (
          <p className="muted">This repo has no git URL. <a href="#/">Add one on the Repositories page</a> to analyze it from here.</p>
        )
      )}
      {error && <p className="error">{error}</p>}
      <p className="muted">Or, from a checkout of the repo, run:</p>
      <pre>{`CODEATLAS_URL=${location.origin} CODEATLAS_TOKEN=<api token> \\
  codeatlas scan . --repo ${name}`}</pre>
    </div>
  );
}

function Views({ model, tab, go, system, config, userGroups, onEditGroups }: {
  model: Model; tab: Tab; go: (t: Tab) => void; system: string;
  config?: RepoConfig; userGroups?: GroupOverrides; onEditGroups?: (o: GroupOverrides) => void;
}) {
  const services = useMemo(() => model.services().filter((s) => !model.splitModules().has(s.id)), [model]);
  const databases = useMemo(() => model.ofKind("database"), [model]);
  // default to the service with the most types: usually the most interesting one
  const [service, setService] = useState(() =>
    [...services].sort((a, b) => typeCount(model, b.id) - typeCount(model, a.id))[0]?.id);
  const containers = useMemo(() => (service ? typeContainers(model, service) : []), [model, service]);
  const [pkg, setPkg] = useState<string>();
  const [database, setDatabase] = useState<string>("");
  const [flowStart, setFlowStartRaw] = useState<string>();
  // Flow tab "step into": the functions entered from the call tree, outermost first
  const [flowPath, setFlowPath] = useState<string[]>([]);
  const [flowHighlight, setFlowHighlight] = useState<string>();
  // a box holding several things fans them out on the canvas: id of the box + what it holds
  const [fan, setFan] = useState<{ from: string; label: string; items: (Choice & { open: () => void })[] }>();
  // Explore: the levels entered from the level-0 context, outermost first
  const [explorePath, setExplorePath] = useState<Scope[]>([{ kind: "context" }]);
  const [exploreHighlight, setExploreHighlight] = useState<string>();
  // Explore: every layer below the current level in one nested diagram
  const [allLayers, setAllLayers] = useState(false);
  // All: how much detail, 1 = outermost boxes only; unset = the last level (everything open)
  const [allLevel, setAllLevel] = useState<number>();
  const here = explorePath[explorePath.length - 1];
  const setFlowStart = (id: string) => {
    setFlowStartRaw(id);
    setFlowPath([]);
    setFlowHighlight(undefined);
  };
  const [selected, setSelected] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [dfdScope, setDfdScope] = useState("context");
  const [onlySensitive, setOnlySensitive] = useState(false);
  const eps = useMemo(() => endpoints(model), [model]);
  // where work starts without an HTTP request: consumers, socket servers, jobs, threads, main
  const otherEntries = useMemo(() => services.flatMap((s) =>
    entryPoints(model, s.id).filter((e) => e.kind !== "http").map((e) => ({ ...e, service: s.name }))), [model, services]);
  const functions = useMemo(() => chartableFunctions(model), [model]);
  const [activityFn, setActivityFn] = useState<string>();
  const [seqStart, setSeqStart] = useState<string>();
  const [seqDepth, setSeqDepth] = useState(3);
  const roots = useMemo(() => programRoots(model), [model]);
  const [programPick, setProgramRoot] = useState<string>();
  // one program at a time; "all" draws every program together
  const programRoot = programPick && (programPick === "all" || roots.some((r) => r.id === programPick)) ? programPick : roots[0]?.id ?? "all";
  const program = useMemo(() => (tab === "program" ? programModel(model, programRoot) : undefined), [tab, model, programRoot]);

  // default package: the one with the most types
  const pkgId = pkg && containers.some((c) => c.id === pkg) ? pkg : busiest(model, containers);
  // default flow: the endpoint whose handler touches the most data stores / systems
  const start = flowStart ?? [...eps].sort((a, b) => b.touches.length - a.touches.length)[0]?.node.id ?? otherEntries[0]?.id;
  // activity defaults to the handler of that endpoint, sequence to the endpoint itself
  const handlerOf = (id?: string) => (model.out.get(id ?? "") ?? []).find((e) => e.kind === "handles")?.target;
  const actFn = activityFn ?? handlerOf(start) ?? (start && functions.some((f) => f.id === start) ? start : undefined) ?? functions[0]?.id;
  const seqFrom = seqStart ?? start ?? functions[0]?.id;
  const seq = useMemo(() => (tab === "sequence" && seqFrom ? sequenceOf(model, seqFrom, seqDepth) : undefined),
    [tab, model, seqFrom, seqDepth]);

  const view: ViewModel | undefined = useMemo(() => {
    switch (tab) {
      case "explore": return allLayers ? allLayersView(model, here) : scopeView(model, here, system);
      case "architecture": return architectureView(model);
      case "dataflow":
        return dfdScope === "context" ? contextDataFlow(model, system, onlySensitive)
          : dfdScope === "system" ? systemDataFlow(model, onlySensitive) : serviceDataFlow(model, dfdScope, onlySensitive);
      case "components": return service ? componentsView(model, service) : undefined;
      case "classes": return pkgId ? classView(model, pkgId) : undefined;
      case "er": return erView(model, database || undefined);
      case "deployment": return deploymentView(model);
      case "flow":
        if (flowPath.length) return activityView(model, flowPath[flowPath.length - 1]);
        return start ? flowView(model, start) : undefined;
      case "activity": return actFn ? activityView(model, actFn) : undefined;
      case "program": return program?.view;
    }
    return undefined;
  }, [tab, model, service, pkgId, database, start, dfdScope, onlySensitive, actFn, system, program, flowPath, here, allLayers]);
  // choices fanned out on the canvas belong to the diagram they were opened on
  useEffect(() => setFan(undefined), [view]);
  // every diagram has its outline beside it (the same boxes read top to bottom); it can be hidden
  const [showOutline, setShowOutline] = useState(() => {
    try {
      return localStorage.getItem("codeatlas.outline") !== "off";
    } catch {
      return true;
    }
  });
  const toggleOutline = () => setShowOutline((on) => {
    try {
      localStorage.setItem("codeatlas.outline", on ? "off" : "on");
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    return !on;
  });
  const outline = tab === "sequence" ? (seq && seqFrom ? sequenceOutline(seq, `Sequence · ${model.node(seqFrom)?.name ?? ""}`) : undefined)
    : tab === "program" ? program?.outline : view?.outline;

  // ---- Explore: go inside any box, from level 0 down to a function's logic
  const exploreTo = (path: Scope[]) => {
    setAllLevel(undefined);
    setSelected(undefined);
    setExploreHighlight(undefined);
    setExplorePath(path);
  };
  const exploreBack = (to = explorePath.length - 2) => {
    if (to < 0 || explorePath.length < 2) return;
    setAllLevel(undefined);
    setSelected(undefined);
    // highlight the box we came out of
    const left = explorePath[to + 1];
    setExploreHighlight(left.kind === "system" ? DFD_SYSTEM : left.id);
    setExplorePath((p) => p.slice(0, to + 1));
  };
  /** Targets of "Inside" for a box in the current tab. */
  const insideTargets = (node: VNode): { scope: Scope; label: string }[] => {
    if (tab === "explore") return insideOf(model, here, node);
    if (tab === "dataflow" && node.id === DFD_SYSTEM) return [{ scope: { kind: "system" }, label: system }];
    if (node.refs?.length && !node.ref?.startsWith("table:")) {
      return node.refs.map((r) => ({ scope: { kind: "function" as const, id: r.id }, label: r.label }));
    }
    const n = node.ref ? model.node(node.ref) : undefined;
    const sc = n && scopeOfNode(model, n);
    return sc ? [{ scope: sc, label: scopeLabel(model, sc, system) }] : [];
  };
  const goInside = (target: Scope) => {
    if (tab === "explore") {
      // recursion (a function calling one already open) jumps back to it instead of growing forever
      const seen = explorePath.findIndex((s) => sameScope(s, target));
      return exploreTo(seen >= 0 ? explorePath.slice(0, seen + 1) : [...explorePath, target]);
    }
    // from another tab: open Explore at that level, with the full path back to level 0
    exploreTo(target.id ? pathTo(model, target.id) : [{ kind: "context" }, { kind: "system" }]);
    go("explore");
  };
  /** "Inside": one target goes straight in, several fan out next to the box. */
  const onInside = (node: VNode) => {
    const targets = insideTargets(node);
    if (targets.length === 1) goInside(targets[0].scope);
    else if (targets.length > 1) {
      // a step's targets are the functions it calls; any other box's are what it contains
      setFan({ from: node.id, label: node.refs?.length ? "calls" : "contains", items: targets.map((t) => ({
        key: `${t.scope.kind}:${t.scope.id ?? ""}`, label: t.label, ref: t.scope.id,
        sub: `${LEVEL[t.scope.kind]} · ▸ Inside`, open: () => goInside(t.scope),
      })) });
    }
  };
  useEffect(() => {
    if (tab !== "explore" || explorePath.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        exploreBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Flow: go inside functions and come back
  const enter = (id: string) => {
    setSelected(undefined);
    setFlowHighlight(undefined);
    setFlowPath((p) => [...p, id]);
  };
  const back = (to = flowPath.length - 1) => {
    if (to < 0 || !flowPath.length) return;
    setSelected(undefined);
    // highlight where we came out of, without opening the details panel
    setFlowHighlight(flowPath[to]);
    setFlowPath((p) => p.slice(0, to));
  };
  /** "Inside" button: one callee goes straight in, several fan out next to the step. */
  const onFlowEnter = (node: VNode) => {
    const refs = node.refs ?? [];
    if (refs.length === 1) enter(refs[0].id);
    else if (refs.length > 1) {
      setFan({ from: node.id, label: "calls", items: refs.map((r) => ({ key: r.id, label: r.label, ref: r.id, sub: "function · ▸ Inside", open: () => enter(r.id) })) });
    }
  };
  /** Inside on a fanned-out choice opens it; on anything else it is the tab's own Inside. */
  const onEnterBox = (node: VNode) => {
    const choice = node.id.startsWith(CHOICE) ? fan?.items.find((c) => CHOICE + c.key === node.id) : undefined;
    if (choice) return choice.open();
    return tab === "flow" ? onFlowEnter(node) : onInside(node);
  };
  const canEnterBox = (node: VNode) => node.id.startsWith(CHOICE) ? true
    : tab === "flow" ? !!node.enterable
    : tab === "explore" && allLayers ? false
    : insideTargets(node).length > 0;
  useEffect(() => {
    if (tab !== "flow" || !flowPath.length) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return; // typing, not navigating
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // the repo's .codeatlas.yml first, then saved edits on top
  const grouping = useMemo(() => mergeOverrides(configOverrides(config, model), userGroups), [config, model, userGroups]);
  const shown = useMemo(() => {
    const v = view ? applyOverrides(view, grouping) : undefined;
    return v && fan ? withChoices(v, fan.from, fan.items, fan.label) : v;
  }, [view, grouping, fan]);
  const edited = !!userGroups && Object.keys(userGroups.rename).length + Object.keys(userGroups.assign).length
    + Object.keys(userGroups.levels ?? {}).length > 0;
  // All: the detail levels this diagram actually has, named (and renamed) after what they show
  const levels = useMemo(() => (tab === "explore" && allLayers && shown ? detailLevels(shown, userGroups?.levels) : undefined),
    [tab, allLayers, shown, userGroups?.levels]);
  const level = levels ? Math.min(Math.max(allLevel ?? levels.length, 1), levels.length) : undefined;
  useEffect(() => {
    if (!levels || !level) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "[" && level > 1) setAllLevel(level - 1);
      if (e.key === "]" && level < levels.length) setAllLevel(level + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [levels, level]);
  const editGroups = onEditGroups && ((f: (o: GroupOverrides) => GroupOverrides) =>
    onEditGroups(f(userGroups ?? { rename: {}, assign: {} })));
  const flowInfo = tab === "dataflow" || tab === "program" ? shown?.edges.find((e) => e.id === selectedEdge)?.info : undefined;

  const showFlow = (id: string) => {
    setFlowStart(id);
    setSelected(undefined);
    go("flow");
  };
  const showActivity = (id: string) => {
    setActivityFn(model.node(id)?.kind === "endpoint" ? handlerOf(id) ?? id : id);
    setSelected(undefined);
    go("activity");
  };
  const showSequence = (id: string) => {
    setSeqStart(id);
    setSelected(undefined);
    go("sequence");
  };
  const showClasses = (node: GraphNode) => {
    const svc = model.appsTouching(node.id).find((a) => a.kind === "service")
      ?? model.owner(node.id, new Set(["service", "module"]));
    if (svc && !model.splitModules().has(svc.id)) setService(svc.id);
    if (node.parent) setPkg(node.parent);
    go("classes");
  };

  return (
    <div className="ws-body">
      <div className="ws-main">
        <div className="toolbar">
          {tab === "explore" && (
            <div className="segmented" role="group" aria-label="How much to show">
              <button className={allLayers ? "secondary" : "primary"} aria-pressed={!allLayers} onClick={() => setAllLayers(false)}
                title="Only this level; ▸ Inside goes one level deeper">One</button>
              <button className={allLayers ? "primary" : "secondary"} aria-pressed={allLayers}
                onClick={() => { setAllLayers(true); setAllLevel(undefined); }}
                title="Every layer below this level in one diagram: services › packages › classes › functions › steps">All</button>
            </div>
          )}
          {levels && level && levels.length > 1 && (
            <LevelLadder levels={levels} level={level} onLevel={setAllLevel}
              onRename={editGroups && ((key, name) => editGroups((o) => ({ ...o, levels: { ...(o.levels ?? {}), [key]: name } })))} />
          )}
          {tab === "program" && roots.length > 0 && (
            <label>
              Program
              <select value={programRoot} onChange={(e) => { setProgramRoot(e.target.value); setSelectedEdge(undefined); }}>
                {roots.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                {roots.length > 1 && <option value="all">All programs together ({roots.length})</option>}
              </select>
            </label>
          )}
          {tab === "program" && (
            <span className="muted small legend">? condition · ↻ loop · = calculation · → call · ⇉ starts · ⛁ data store · ⇶ messaging · ⇄ HTTP</span>
          )}
          {tab === "dataflow" && (
            <>
              <label>
                Level
                <select value={dfdScope} onChange={(e) => { setDfdScope(e.target.value); setSelectedEdge(undefined); }}>
                  <option value="context">Context diagram (level 0)</option>
                  <option value="system">System (level 1)</option>
                  {services.filter((s) => entryPoints(model, s.id).length).map((s) => (
                    <option key={s.id} value={s.id}>Inside {s.name} (level 2)</option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={onlySensitive} onChange={(e) => setOnlySensitive(e.target.checked)} />
                Only sensitive data
              </label>
            </>
          )}
          {(tab === "components" || tab === "classes") && (
            <label>
              Service
              <select value={service} onChange={(e) => { setService(e.target.value); setPkg(undefined); }}>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {tab === "classes" && (
            <label>
              Package
              <select value={pkgId} onChange={(e) => setPkg(e.target.value)}>
                {containers.map((c) => <option key={c.id} value={c.id}>{c.kind === "package" ? c.name : `${c.name} (root)`}</option>)}
              </select>
            </label>
          )}
          {tab === "er" && (
            <label>
              Database
              <select value={database} onChange={(e) => setDatabase(e.target.value)}>
                <option value="">All databases</option>
                {databases.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {tab === "flow" && (
            <label>
              Start
              <select value={start} onChange={(e) => setFlowStart(e.target.value)}>
                {eps.length > 0 && (
                  <optgroup label="HTTP endpoints">
                    {eps.map((ep) => <option key={ep.node.id} value={ep.node.id}>{ep.service?.name} · {ep.node.name}</option>)}
                  </optgroup>
                )}
                {(["socket", "consumer", "scheduled", "thread", "main"] as const).map((k) => {
                  const list = otherEntries.filter((e) => e.kind === k);
                  return list.length ? (
                    <optgroup key={k} label={ENTRY_GROUPS[k]}>
                      {list.map((e) => <option key={e.id} value={e.id}>{e.service} · {e.label}</option>)}
                    </optgroup>
                  ) : null;
                })}
                {start && !eps.some((ep) => ep.node.id === start) && !otherEntries.some((e) => e.id === start) && (
                  <option value={start}>{model.node(start)?.name}</option>
                )}
              </select>
            </label>
          )}
          {tab === "activity" && (
            <FunctionPicker label="Function" model={model} options={functions} value={actFn} onChange={setActivityFn} />
          )}
          {tab === "sequence" && (
            <>
              <FunctionPicker label="Start" model={model}
                options={[...eps.map((e) => e.node), ...otherEntries.map((e) => model.node(e.id)!).filter(Boolean), ...functions]}
                value={seqFrom} onChange={setSeqStart} />
              <label>
                Depth
                <select value={seqDepth} onChange={(e) => setSeqDepth(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </>
          )}
          {editGroups && edited && tab !== "api" && tab !== "sequence" && (
            <button className="secondary" title="Undo every rename and move saved for this repo"
              onClick={() => editGroups(() => ({ rename: {}, assign: {}, levels: {} }))}>Reset grouping</button>
          )}
          {view && tab !== "api" && (
            <DiagramExport name={tab === "dataflow" ? `dataflow-${dfdScope === "context" || dfdScope === "system" ? dfdScope : "service"}` : tab === "explore" ? `explore-${here.kind}` : tab}
              mermaid={() => toMermaid(tab === "explore" ? EXPORT_KIND[here.kind] : tab as ViewKind, shown ?? view)}
              plantuml={() => (tab === "activity" && actFn ? activityToPlantUml(model, actFn)
                : tab === "explore" && here.kind === "function" && here.id ? activityToPlantUml(model, here.id)
                : toPlantUml(tab === "explore" ? EXPORT_KIND[here.kind] : tab as ViewKind, shown ?? view))} />
          )}
          {seq && tab === "sequence" && (
            <DiagramExport name="sequence" mermaid={() => sequenceToMermaid(seq)} plantuml={() => sequenceToPlantUml(seq)} />
          )}
          {outline && outline.parts.length > 0 && (
            <button className={showOutline ? "primary" : "secondary"} aria-pressed={showOutline} onClick={toggleOutline}
              title="The same diagram as an outline: each part in the order data moves, with what goes in and out">Outline</button>
          )}
        </div>
        {tab === "api" ? (
          <ApiTable endpoints={eps} onFlow={showFlow} onSelect={setSelected} />
        ) : tab === "sequence" ? (
          seq ? (
            <div className={showOutline && outline?.parts.length ? "program-split" : "canvas-only"}>
              <SequenceDiagram seq={seq} selected={selected} onSelect={setSelected} />
              {showOutline && outline && outline.parts.length > 0 && <ProgramOutline outline={outline} selected={selected} onSelect={setSelected} />}
            </div>
          ) : <p className="muted pad">Pick a start.</p>
        ) : view ? (
          <>
          {tab === "flow" && start && (
            <FlowTrail model={model} start={start} path={flowPath} onBack={back}
              onDetails={(id) => setSelected(id)} />
          )}
          {tab === "explore" && (
            <ExploreTrail model={model} system={system} path={explorePath} onBack={exploreBack} allLayers={allLayers}
              onDetails={(id) => setSelected(id)} />
          )}
          <div className={showOutline && outline?.parts.length ? "program-split" : "canvas-only"}>
          <GraphCanvas view={shown ?? view} level={level}
            selected={selected ?? (tab === "flow" ? flowHighlight : tab === "explore" ? exploreHighlight : undefined)}
            onRenameGroup={editGroups && ((gid, label) => editGroups((o) => ({ ...o, rename: { ...o.rename, [gid]: label } })))}
            onEnter={onEnterBox}
            canEnter={canEnterBox}
            onSelect={(id, node) => {
              // clicking elsewhere puts fanned-out choices away; clicking one keeps them
              if (!node?.id.startsWith(CHOICE) && node?.id !== fan?.from) setFan(undefined);
              if (tab === "explore") setExploreHighlight(undefined);
              if (tab === "flow") setFlowHighlight(undefined);
              // the context diagram's system box opens level 1
              if (tab === "dataflow" && id === DFD_SYSTEM) {
                setDfdScope("system");
                return;
              }
              setSelected(id);
              setSelectedEdge(undefined);
            }}
            selectedEdge={selectedEdge} onSelectEdge={(id) => { setSelectedEdge(id); if (id) setSelected(undefined); }} />
          {showOutline && outline && outline.parts.length > 0 && (
            <ProgramOutline outline={outline} selected={selected} onSelect={(id) => { setSelected(id); setSelectedEdge(undefined); }} />
          )}
          </div>
          </>
        ) : (
          <p className="muted pad">Nothing to show.</p>
        )}
      </div>
      {flowInfo && <FlowDetails model={model} info={flowInfo} onSelect={setSelected} onClose={() => setSelectedEdge(undefined)} />}
      {selected && model.node(selected) && (
        <Details model={model} id={selected} onSelect={setSelected} onClose={() => setSelected(undefined)}
          onFlow={showFlow} onClasses={showClasses} onActivity={showActivity} onSequence={showSequence}
          group={groupOf(shown, selected)}
          onMove={editGroups && tab !== "sequence" && tab !== "api" && shown?.nodes.some((n) => n.ref === selected || n.id === selected)
            ? (name) => editGroups((o) => ({ ...o, assign: { ...o.assign, [selected]: name } })) : undefined} />
      )}
    </div>
  );
}

// ------------------------------------------------------------ level ladder

/**
 * The detail levels of the All view, outermost first: pick one to fold every box that deep,
 * step with − / +, rename one (✎) to whatever reads best for this codebase.
 */
function LevelLadder({ levels, level, onLevel, onRename }: {
  levels: Level[]; level: number; onLevel: (l: number) => void; onRename?: (key: string, name: string) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const current = levels[level - 1];
  const save = (key: string, value: string) => {
    // an empty name, or the default one, goes back to the default
    onRename?.(key, value.trim() === key ? "" : value.trim());
    setEditing(undefined);
  };
  return (
    <div className="level-ladder" role="group" aria-label="Detail level">
      <button className="secondary" disabled={level <= 1} onClick={() => onLevel(level - 1)} title="Less detail: fold one more level ( [ )">−</button>
      <ol className="level-steps">
        {levels.map((l) => (
          <li key={l.key}>
            {editing === l.key ? (
              <input className="level-rename" autoFocus defaultValue={l.name} aria-label={`Name of level ${l.level}`}
                onBlur={(e) => save(l.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save(l.key, (e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setEditing(undefined);
                }} />
            ) : (
              <button className={`level-step${l.level === level ? " on" : ""}${l.level < level ? " open" : ""}`}
                aria-pressed={l.level === level} onClick={() => onLevel(l.level)}
                onDoubleClick={() => onRename && setEditing(l.key)}
                title={l.boxes ? `Level ${l.level}: ${l.boxes} ${l.name.toLowerCase()} folded into boxes${l.name !== l.key ? ` (${l.key})` : ""}`
                  : `Level ${l.level}: everything open`}>
                <span className="level-num">{l.level}</span>{l.name}
              </button>
            )}
          </li>
        ))}
      </ol>
      <button className="secondary" disabled={level >= levels.length} onClick={() => onLevel(level + 1)} title="More detail: open one more level ( ] )">+</button>
      {onRename && !editing && (
        <button className="link small" onClick={() => setEditing(current.key)} title={`Rename “${current.name}”`}>✎ rename</button>
      )}
    </div>
  );
}

// --------------------------------------------------------- explore trail

/** Which diagram format each Explore level exports as. */
const EXPORT_KIND: Record<Scope["kind"], ViewKind> = {
  context: "dataflow", system: "architecture", service: "components", package: "flow",
  class: "flow", function: "activity", database: "er",
};

/** Breadcrumbs from level 0 down to where you are, with Back and the "inside which?" menu. */
function ExploreTrail({ model, system, path, onBack, allLayers, onDetails }: {
  model: Model; system: string; path: Scope[]; onBack: (to?: number) => void; allLayers: boolean;
  onDetails: (id: string) => void;
}) {
  const here = path[path.length - 1];
  return (
    <div className="flow-trail">
      {path.length > 0 && (
        <nav aria-label="Where you are" className="flow-crumbs">
          {path.length > 1 && <button className="secondary" onClick={() => onBack()} title="Back (Esc)">← Back</button>}
          {path.map((s, i) => (
            <span key={`${s.kind}-${s.id ?? ""}`} className="crumb-wrap">
              {i > 0 && <span className="muted" aria-hidden>›</span>}
              <button className={`crumb${i === path.length - 1 ? " here" : ""}`} disabled={i === path.length - 1}
                onClick={() => onBack(i)} title={LEVEL[s.kind]}>
                {scopeLabel(model, s, system)}
              </button>
            </span>
          ))}
          {here?.id && <button className="link small" onClick={() => onDetails(here.id!)}>ⓘ Details</button>}
          <span className="muted small flow-hint">
            {allLayers ? "Everything below this level · pick a detail level, or click a box to fold or unfold it"
              : `${here ? LEVEL[here.kind] : ""} · click a box, then ▸ Inside`}
          </span>
        </nav>
      )}
    </div>
  );
}

// ------------------------------------------------------------ flow trail

/** Breadcrumbs for the Flow tab's "step into": call tree › function › function, with Back. */
function FlowTrail({ model, start, path, onBack, onDetails }: {
  model: Model; start: string; path: string[]; onBack: (to?: number) => void; onDetails: (id: string) => void;
}) {
  const startNode = model.node(start);
  const current = path[path.length - 1];
  return (
    <div className="flow-trail">
      <nav aria-label="Where you are in the flow" className="flow-crumbs">
        {path.length > 0 && <button className="secondary" onClick={() => onBack()} title="Back (Esc)">← Back</button>}
        <button className={`crumb${path.length ? "" : " here"}`} onClick={() => onBack(0)} disabled={!path.length}>
          {startNode?.kind === "endpoint" ? startNode.name : startNode ? callableLabel(model, startNode) : start} <span className="muted">call tree</span>
        </button>
        {path.map((id, i) => {
          const n = model.node(id);
          return (
            <span key={`${id}-${i}`} className="crumb-wrap">
              <span className="muted" aria-hidden>›</span>
              <button className={`crumb${i === path.length - 1 ? " here" : ""}`} onClick={() => onBack(i + 1)} disabled={i === path.length - 1}>
                {n ? callableLabel(model, n) : id}
              </button>
            </span>
          );
        })}
        {current && <button className="link small" onClick={() => onDetails(current)}>ⓘ Details</button>}
        <span className="muted small flow-hint">
          {path.length ? "▸ Inside on a step goes deeper · Esc to go back" : "▸ Inside on a function shows what it does"}
        </span>
      </nav>
    </div>
  );
}

// -------------------------------------------------------------- pickers

/** Searchable dropdown over endpoints/functions (lists can be long in real repos). */
function FunctionPicker({ label, model, options, value, onChange }: {
  label: string; model: Model; options: GraphNode[]; value?: string; onChange: (id: string) => void;
}) {
  const items = useMemo<PickerOption[]>(() => {
    const seen = new Set<string>();
    const out: PickerOption[] = [];
    for (const n of options) {
      if (seen.has(n.id)) continue; // the same function can be both an entry point and a plain function
      seen.add(n.id);
      const one = model.appsOf(n.id).filter((a) => a.kind === "service");
      const svc = (one.length === 1 ? one[0] : model.owner(n.id, new Set(["service", "module"])))?.name;
      const owner = n.parent ? model.node(n.parent) : undefined;
      const name = n.kind === "endpoint" ? n.name
        : owner && ["class", "interface", "enum"].includes(owner.kind) ? `${owner.name}.${n.name === "<init>" ? "new" : n.name}` : n.name;
      const params = (n.attrs?.params as { type: string }[] | undefined)?.map((p) => p.type).join(", ");
      const kind = n.kind === "endpoint" ? "endpoint" : n.attrs?.entryPoint ? `${n.attrs.entryPoint} entry point` : undefined;
      out.push({
        id: n.id,
        label: n.kind === "endpoint" || params === undefined ? name : `${name}(${params})`,
        hint: [svc, kind, locationText(n)].filter(Boolean).join(" · "),
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [options, model]);
  return <SearchPicker label={label} options={items} value={value} onChange={onChange} placeholder="Search by class, method, service or file…" />;
}

// ------------------------------------------------------------ data flow

function FlowDetails({ model, info, onSelect, onClose }: {
  model: Model; info: FlowInfo; onSelect: (id: string) => void; onClose: () => void;
}) {
  const classes = [...info.classes].sort((a, b) => sevRank(CLASS_INFO[a[0]].severity) - sevRank(CLASS_INFO[b[0]].severity));
  return (
    <aside className="details" aria-label="Data flow details">
      <div className="details-head">
        <span className="tag">data flow</span>
        <button className="link" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <h2>{info.title}</h2>

      <section>
        <h3>Sensitive data</h3>
        {classes.length === 0 ? <p className="muted small">None detected from field names.</p> : (
          <ul className="links">
            {classes.map(([cls, paths]) => (
              <li key={cls}>
                <span className={`sev sev-${CLASS_INFO[cls].severity}`}>{CLASS_INFO[cls].label}</span>{" "}
                <span className="mono">{paths.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Data <span className="muted">{info.types.length}</span></h3>
        {info.types.length === 0 && <p className="muted small">Type not known statically.</p>}
        {info.types.map((t) => {
          const fields = t.typeId ? (model.children.get(t.typeId) ?? []).filter((c) => c.kind === "field" && !c.attrs?.static) : [];
          return (
            <div key={t.type} className="type-card">
              {t.typeId ? <button className="link mono" onClick={() => onSelect(t.typeId!)}>{t.type}</button> : <span className="mono">{t.type}</span>}
              {fields.length > 0 && (
                <ul className="fields">
                  {fields.map((f) => {
                    const cls = classifyName(f.name, model.node(t.typeId!)?.name);
                    return (
                      <li key={f.id} className="mono small">
                        {f.name}: <span className="muted">{String(f.attrs?.type ?? "")}</span>
                        {cls && <span className={`sev sev-${CLASS_INFO[cls].severity}`}>{CLASS_INFO[cls].label}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h3>In the code <span className="muted">{info.sources.length}</span></h3>
        <ul className="links">
          {info.sources.map((s, i) => {
            const n = model.node(s.node);
            return (
              <li key={i}>
                <button className="link" onClick={() => onSelect(s.node)}>{n ? (n.kind === "endpoint" ? n.name : qualifiedLabel(model, n)) : s.node}</button>
                <span className="muted small"> {s.kind.replace("_", " ")}</span>
                {s.location && <div className="muted small mono">{locationText(s)}</div>}
                {s.conditions?.map((c) => <div key={c} className="small cond">only {c}</div>)}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function sevRank(s: string) {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

function qualifiedLabel(model: Model, n: GraphNode) {
  const owner = n.parent ? model.node(n.parent) : undefined;
  return owner && ["class", "interface", "enum"].includes(owner.kind) ? `${owner.name}.${n.name}` : n.name;
}

function typeCount(model: Model, id: string) {
  let n = 0;
  for (const id2 of model.codeScope(id)) {
    const k = model.node(id2)?.kind;
    if (k === "class" || k === "interface" || k === "enum") n++;
  }
  return n;
}

function busiest(model: Model, containers: GraphNode[]) {
  let best: string | undefined;
  let max = -1;
  for (const c of containers) {
    const n = (model.children.get(c.id) ?? []).filter((k) => ["class", "interface", "enum"].includes(k.kind)).length;
    if (n > max) [best, max] = [c.id, n];
  }
  return best;
}

// -------------------------------------------------------------- export

/** Copy or download a view as Mermaid or PlantUML (texts are built on demand). */
function DiagramExport({ name, mermaid, plantuml }: { name: string; mermaid: () => string; plantuml: () => string }) {
  const [done, setDone] = useState("");
  const download = (text: string, ext: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.${ext}` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async (text: string, what: string, ext: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(what);
      setTimeout(() => setDone(""), 1500);
    } catch {
      download(text, ext);
    }
  };
  // one menu: exporting is occasional, the diagram should get the space
  return (
    <div className="export">
      <details className="menu">
        <summary className="secondary">{done ? `Copied ${done}` : "Export ▾"}</summary>
        <div className="menu-list">
          <button className="link" onClick={() => copy(mermaid(), "Mermaid", "mmd")}>Copy as Mermaid</button>
          <button className="link" onClick={() => copy(plantuml(), "PlantUML", "puml")}>Copy as PlantUML</button>
          <button className="link" onClick={() => download(mermaid(), "mmd")}>Download {name}.mmd</button>
          <button className="link" onClick={() => download(plantuml(), "puml")}>Download {name}.puml</button>
        </div>
      </details>
    </div>
  );
}

// ----------------------------------------------------------------- API

/** What an endpoint receives: its request body type and its path / query / header inputs. */
function ApiData({ model: ep }: { model: GraphNode }) {
  const req = (ep.attrs?.request as { type: string } | undefined)?.type;
  const inputs = (ep.attrs?.inputs as { name: string; type?: string; in?: string }[] | undefined) ?? [];
  if (!req && !inputs.length) return <span className="muted">—</span>;
  return (
    <>
      {req && <div><code>{req}</code></div>}
      {inputs.length > 0 && (
        <div className="muted small">{inputs.map((i) => `${i.name}${i.type ? `: ${i.type}` : ""}${i.in ? ` (${i.in})` : ""}`).join(", ")}</div>
      )}
    </>
  );
}

function ApiTable({ endpoints: eps, onFlow, onSelect }: {
  endpoints: ReturnType<typeof endpoints>;
  onFlow: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  if (!eps.length) return <p className="muted pad">No endpoints found.</p>;
  const sorted = [...eps].sort((a, b) =>
    (a.service?.name ?? "").localeCompare(b.service?.name ?? "") || String(a.node.attrs?.route).localeCompare(String(b.node.attrs?.route)));
  return (
    <div className="table-wrap api-table">
      <table>
        <thead>
          <tr><th>Service</th><th>Endpoint</th><th>Receives</th><th>Returns</th><th>Does</th><th>Handler</th><th /></tr>
        </thead>
        <tbody>
          {sorted.map((ep) => (
            <tr key={ep.node.id}>
              <td>{ep.service?.name}</td>
              <td>
                <button className="link" onClick={() => onSelect(ep.node.id)}>
                  <span className={`verb verb-${verbOf(ep.node).toLowerCase()}`}>{verbOf(ep.node)}</span>{" "}
                  <code>{routeOf(ep.node)}</code>
                </button>
                {typeof ep.node.attrs?.summary === "string" && <div className="muted small">{ep.node.attrs.summary}</div>}
              </td>
              <td><ApiData model={ep.node} /></td>
              <td>{(ep.node.attrs?.response as { type: string } | undefined)?.type
                ? <code>{(ep.node.attrs!.response as { type: string }).type}</code> : <span className="muted">—</span>}</td>
              <td>
                {ep.does && <div className="small">{ep.does}</div>}
                <div className="chips">
                  {ep.touches.map((t) => <span key={t.id} className={`touch touch-${t.kind}`} title={t.kind}>{t.name}</span>)}
                </div>
              </td>
              <td>
                {ep.handler ? (
                  <>
                    <button className="link" onClick={() => onSelect(ep.handler!.id)}>{ep.handler.name}</button>
                    <div className="muted small">{locationText(ep.handler)}</div>
                  </>
                ) : <span className="muted">— (spec only)</span>}
              </td>
              <td>{ep.handler && <button className="secondary" onClick={() => onFlow(ep.node.id)}>Flow</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** HTTP method, or the protocol for socket endpoints (TCP / WS) that have none. */
function verbOf(ep: GraphNode): string {
  if (ep.attrs?.method) return String(ep.attrs.method);
  return ep.attrs?.protocol ? String(ep.attrs.protocol).toUpperCase() : "ANY";
}

function routeOf(ep: GraphNode): string {
  if (ep.attrs?.route) return String(ep.attrs.route);
  return ep.attrs?.port ? `:${ep.attrs.port}` : ep.name;
}

// ------------------------------------------------------------- details

const EDGE_LABEL: Record<string, [string, string]> = {
  calls: ["calls", "called by"], handles: ["handled by", "handles"], reads: ["reads", "read by"], writes: ["writes", "written by"],
  publishes: ["publishes to", "published by"], consumes: ["consumes", "consumed by"], http_calls: ["HTTP calls", "HTTP called by"],
  extends: ["extends", "extended by"], implements: ["implements", "implemented by"], references: ["references", "referenced by"],
  depends_on: ["depends on", "used by"], deploys: ["runs", "run by"], connects_to: ["connects to", "connected from"],
};

/** Shows the node's diagram group; admins can move it into another (new or existing) group. */
function GroupField({ group, onMove }: { group: { label?: string; options: string[] }; onMove?: (g: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <section>
      <h3>Group</h3>
      <div className="small">{group.label ?? <span className="muted">none</span>}</div>
      {onMove && (
        <form className="row group-move" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onMove(value.trim()); setValue(""); }}>
          <input list="group-names" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Move to group…" aria-label="Move to group" />
          <datalist id="group-names">{group.options.map((o) => <option key={o} value={o} />)}</datalist>
          <button className="secondary" type="submit" disabled={!value.trim()}>Move</button>
          <button className="link small" type="button" title="Back to its automatic group" onClick={() => onMove("")}>reset</button>
        </form>
      )}
    </section>
  );
}

/** The group a graph node sits in within a view, and every group label (for moving it). */
function groupOf(view: ViewModel | undefined, id: string | undefined): { label?: string; options: string[] } | undefined {
  if (!view || !id) return undefined;
  const node = view.nodes.find((n) => n.ref === id || n.id === id);
  if (!node) return undefined;
  const groups = new Map((view.groups ?? []).map((g) => [g.id, g.label]));
  return { label: node.group ? groups.get(node.group) : undefined, options: [...new Set(groups.values())].sort() };
}

function Details({ model, id, onSelect, onClose, onFlow, onClasses, onActivity, onSequence, group, onMove }: {
  model: Model; id: string; onSelect: (id: string) => void; onClose: () => void;
  onFlow: (id: string) => void; onClasses: (n: GraphNode) => void;
  onActivity: (id: string) => void; onSequence: (id: string) => void;
  group?: { label?: string; options: string[] }; onMove?: (group: string) => void;
}) {
  const n = model.node(id)!;
  const groups = (edges: GraphEdge[], outgoing: boolean) => {
    const m = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const label = EDGE_LABEL[e.kind]?.[outgoing ? 0 : 1] ?? e.kind;
      m.set(label, [...(m.get(label) ?? []), e]);
    }
    return [...m];
  };
  const out = groups(model.out.get(id) ?? [], true);
  const inc = groups(model.in.get(id) ?? [], false);
  const parent = n.parent ? model.node(n.parent) : undefined;
  const attrs = Object.entries(n.attrs ?? {}).filter(([k]) => !["columns", "params", "annotations", "controlFlow", "variables", "doc"].includes(k));
  const callable = n.kind === "method" || n.kind === "function";
  const vars = variablesOf(n);
  // for a field: every function that reads or changes it
  const usedBy = n.kind === "field" ? model.graph.nodes.flatMap((f) => {
    const v = variablesOf(f).find((x) => x.declaredIn === n.id);
    return v ? [{ fn: f, v }] : [];
  }) : [];

  return (
    <aside className="details" aria-label="Details">
      <div className="details-head">
        <span className="tag">{n.kind}</span>
        <button className="link" onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <h2>{n.name}</h2>
      {n.qualifiedName && n.qualifiedName !== n.name && <div className="muted small mono">{n.qualifiedName}</div>}
      {parent && <div className="small">in <button className="link" onClick={() => onSelect(parent.id)}>{parent.name}</button></div>}
      {n.location && <div className="small mono">{locationText(n)}</div>}
      <div className="details-actions">
        {(n.kind === "endpoint" || n.kind === "method" || n.kind === "function") && (
          <>
            <button className="secondary" onClick={() => onFlow(id)}>Show flow</button>
            <button className="secondary" onClick={() => onActivity(id)}>Activity</button>
            <button className="secondary" onClick={() => onSequence(id)}>Sequence</button>
          </>
        )}
        {["class", "interface", "enum"].includes(n.kind) && <button className="secondary" onClick={() => onClasses(n)}>Class diagram</button>}
      </div>
      {group && (onMove || group.label) && <GroupField key={id} group={group} onMove={onMove} />}
      {typeof n.attrs?.doc === "string" && !callable && <p className="small doc">{n.attrs.doc}</p>}
      {callable && (
        <section>
          <h3>What it does</h3>
          <ul className="does">
            {whatItDoes(model, n).map((r, i) => (
              <li key={i} className={r.muted ? "muted" : undefined}><span className="atlas-marker">{r.marker}</span> {r.text}</li>
            ))}
          </ul>
        </section>
      )}
      {vars.length > 0 && (
        <section>
          <h3>Variables <span className="muted">{vars.length}</span></h3>
          <table className="vars">
            <thead><tr><th>name</th><th>scope</th><th>declared in</th><th title="reads / changes">r / w</th></tr></thead>
            <tbody>
              {vars.map((v) => {
                const home = OUTSIDE.has(v.scope) ? homeOf(model, v) : undefined;
                return (
                  <tr key={`${v.scope}:${v.name}`} className={home ? "outside" : undefined}>
                    <td className="mono">{v.name}{v.type && <span className="muted">: {v.type}</span>}</td>
                    <td>{SCOPE_TEXT[v.scope]}{v.final ? " · const" : ""}</td>
                    <td>{home ? (home.ref ? <button className="link" onClick={() => onSelect(home.ref!)}>{home.label}</button> : <span className="mono small">{v.declaredIn}</span>)
                      : <span className="muted">here{v.line ? ` · L${v.line}` : ""}</span>}</td>
                    <td className="mono">{v.reads} / {v.writes}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {usedBy.length > 0 && (
        <section>
          <h3>Used by <span className="muted">{usedBy.length}</span></h3>
          <ul className="links">
            {usedBy.map(({ fn, v }) => (
              <li key={fn.id}>
                <button className="link" onClick={() => onSelect(fn.id)}>{callableLabel(model, fn)}</button>
                <span className="muted small"> {v.writes ? `changes it (${v.writes})` : "reads it"}{v.writes && v.reads ? `, reads (${v.reads})` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {n.otel && Object.keys(n.otel).length > 0 && (
        <section>
          <h3>Runtime identity</h3>
          <dl className="kv">
            {Object.entries(n.otel).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </section>
      )}
      {attrs.length > 0 && (
        <section>
          <h3>Attributes</h3>
          <dl className="kv">
            {attrs.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}
          </dl>
        </section>
      )}
      {[...out.map((g) => [...g, true] as const), ...inc.map((g) => [...g, false] as const)].map(([label, edges, outgoing]) => (
        <section key={`${label}-${outgoing}`}>
          <h3>{label} <span className="muted">{edges.length}</span></h3>
          <ul className="links">
            {edges.slice(0, 50).map((e, i) => {
              const other = model.node(outgoing ? e.target : e.source);
              const line = e.locations?.[0]?.startLine;
              return (
                <li key={i}>
                  <button className="link" onClick={() => other && onSelect(other.id)}>{other?.name ?? (outgoing ? e.target : e.source)}</button>
                  {other && <span className="muted small"> {other.kind}</span>}
                  {line && <span className="muted small mono"> · L{line}</span>}
                  {conditionLabel(e) && <div className="small cond">only {(e.attrs?.conditions as string[]).join("; ")}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

// ----------------------------------------------------------- snapshots

function Snapshots({ name, isAdmin, version, onAnalyzed }: {
  name: string; isAdmin: boolean; version: number; onAnalyzed: () => void;
}) {
  const [snaps, setSnaps] = useState<Snapshot[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    api.snapshots(name).then(setSnaps, (e) => setError(e.message));
  }, [name, version]);
  if (error) return <p className="error">{error}</p>;
  if (!snaps) return <p className="muted pad">Loading…</p>;
  if (!snaps.length) return <NoSnapshots name={name} isAdmin={isAdmin} onAnalyzed={onAnalyzed} />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Commit</th><th>Branch</th><th>Analyzer</th><th className="num">Nodes</th><th className="num">Edges</th><th>Uploaded</th></tr>
        </thead>
        <tbody>
          {snaps.map((s) => (
            <tr key={s.id}>
              <td><a href={`#/snapshots/${s.id}`}><code>{s.commit.slice(0, 10)}</code></a></td>
              <td>{s.branch ?? "—"}</td>
              <td>{s.analyzer} <span className="muted">{s.analyzerVersion}</span></td>
              <td className="num">{s.nodeCount}</td>
              <td className="num">{s.edgeCount}</td>
              <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
