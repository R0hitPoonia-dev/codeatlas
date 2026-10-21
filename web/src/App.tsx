import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, ApiError, User } from "./api";
import RepoWorkspace, { parseWorkspaceTab } from "./pages/RepoWorkspace";
import Repos from "./pages/Repos";
import { useLoad } from "./useLoad";

type Route =
  | { page: "repos" }
  | { page: "repo"; name: string; tab?: string }
  | { page: "snapshot"; id: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "repos" && parts[1]) return { page: "repo", name: parts[1], tab: parts[2] };
  if (parts[0] === "snapshots" && parts[1]) return { page: "snapshot", id: parts[1] };
  return { page: "repos" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useRoute();

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (user === null) return <Login onLogin={setUser} />;

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">CodeAtlas</a>
        <span className="muted">{user.email} · {user.role}</span>
        <button className="link" onClick={() => api.logout().finally(() => setUser(null))}>
          Sign out
        </button>
      </header>
      {route.page === "repo" ? (
        <RepoWorkspace key={route.name} name={route.name} tab={parseWorkspaceTab(route.tab)} isAdmin={user.role === "admin"} />
      ) : (
        <main className="page">
          {route.page === "repos" && <Repos user={user} />}
          {route.page === "snapshot" && <SnapshotPage id={route.id} />}
        </main>
      )}
    </>
  );
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin((await api.login(email, password)).user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h1>CodeAtlas</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}

function SnapshotPage({ id }: { id: string }) {
  const { data: graph, error } = useLoad(() => api.graph(id), [id]);
  const [kind, setKind] = useState("");

  const kinds = useMemo(() => countBy(graph?.nodes ?? [], (n) => n.kind), [graph]);
  const names = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n.name])), [graph]);

  if (error) return <p className="error">{error}</p>;
  if (!graph) return <p className="muted">Loading graph…</p>;

  const nodes = kind ? graph.nodes.filter((n) => n.kind === kind) : graph.nodes;
  return (
    <>
      <p><button className="link" onClick={() => history.back()}>← Back</button></p>
      <h1>Snapshot (raw)</h1>
      <p className="muted">{graph.nodes.length} nodes · {graph.edges.length} edges</p>

      <div className="chips">
        <button className={kind === "" ? "chip on" : "chip"} onClick={() => setKind("")}>all</button>
        {[...kinds].map(([k, n]) => (
          <button key={k} className={kind === k ? "chip on" : "chip"} onClick={() => setKind(k)}>
            {k} <span className="muted">{n}</span>
          </button>
        ))}
      </div>

      <h2>Nodes</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Kind</th><th>Name</th><th>Location</th><th>Runtime identity (OTel)</th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id}>
              <td><span className="tag">{n.kind}</span></td>
              <td title={n.id}>{n.qualifiedName ?? n.name}</td>
              <td className="muted">{n.location ? `${n.location.file}${n.location.startLine ? `:${n.location.startLine}` : ""}` : "—"}</td>
              <td className="muted"><code>{n.otel ? Object.entries(n.otel).map(([k, v]) => `${k}=${v}`).join("  ") : ""}</code></td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>Edges</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>From</th><th>Relation</th><th>To</th></tr></thead>
        <tbody>
          {graph.edges.map((e, i) => (
            <tr key={i}>
              <td title={e.source}>{names.get(e.source) ?? e.source}</td>
              <td><span className="tag">{e.kind}</span></td>
              <td title={e.target}>{names.get(e.target) ?? e.target}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}

function countBy<T>(xs: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return new Map([...m].sort());
}
