import { FormEvent, Fragment, useEffect, useState } from "react";
import { api, GitProfile, isActive, Repo, User } from "../api";
import { AnalysisLog, AnalysisStatus } from "../components/Analysis";
import { GitProfilesCard, ProfileSelect } from "../components/GitProfiles";
import { useLoad } from "../useLoad";

type Panel = { name: string; kind: "log" | "url" };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Repos({ user }: { user: User }) {
  const { data: repos, error, reload } = useLoad(api.repos, []);
  const admin = user.role === "admin";
  // git profiles are an admin setting (they hold the server's SSH keys)
  const profilesLoad = useLoad(() => (admin ? api.gitProfiles() : Promise.resolve([] as GitProfile[])), [admin]);
  const profiles = profilesLoad.data ?? [];
  const [addingProfile, setAddingProfile] = useState(false);
  const addProfile = () => {
    setAddingProfile(true);
    setTimeout(() => document.getElementById("git-profiles")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const [panel, setPanel] = useState<Panel>();
  const [busy, setBusy] = useState<string[]>([]); // repos with a request in flight
  const [actionError, setActionError] = useState("");

  // Follow running analyses until they finish.
  const running = repos?.some((r) => isActive(r.analysis)) ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  async function act(name: string, f: () => Promise<unknown>) {
    setActionError("");
    setBusy((b) => [...b, name]);
    try {
      await f();
    } catch (e) {
      setActionError(`${name}: ${errText(e)}`);
    } finally {
      setBusy((b) => b.filter((n) => n !== name));
      reload();
    }
  }
  const analyze = (name: string) => act(name, () => api.startAnalysis(name));
  const cancel = (name: string) => act(name, () => api.cancelAnalysis(name));

  const pending = repos?.filter((r) => r.url && !r.lastCommit && !isActive(r.analysis)) ?? [];
  const needUrl = repos?.filter((r) => !r.url && !r.lastCommit) ?? [];

  async function analyzeAll() {
    for (const r of pending) await analyze(r.name); // the server runs them one at a time
  }

  const toggle = (name: string, kind: Panel["kind"]) =>
    setPanel((p) => (p?.name === name && p.kind === kind ? undefined : { name, kind }));

  return (
    <>
      <div className="page-head">
        <h1>Repositories</h1>
        {admin && pending.length > 0 && (
          <button onClick={analyzeAll} disabled={busy.length > 0}>
            Analyze {pending.length === 1 ? "pending repo" : `all ${pending.length} pending`}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {actionError && <p className="error">{actionError}</p>}
      {admin && needUrl.length > 0 && (
        <p className="muted">
          {needUrl.length === 1 ? "1 repo has" : `${needUrl.length} repos have`} no git URL, so the server can’t
          clone {needUrl.length === 1 ? "it" : "them"}. Add one, or scan from a checkout with the CLI below.
        </p>
      )}
      {repos && repos.length === 0 && (
        <p className="muted">No repositories yet.{admin ? " Register one below." : ""}</p>
      )}
      {repos && repos.length > 0 && (
        <div className="table-wrap"><table className="repos">
          <thead>
            <tr><th>Name</th><th>Source</th><th>Analysis</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {repos.map((r: Repo) => {
              const active = isActive(r.analysis);
              const open = panel?.name === r.name ? panel.kind : undefined;
              const disabled = busy.includes(r.name);
              return (
                <Fragment key={r.id}>
                  <tr>
                    <td><a href={`#/repos/${encodeURIComponent(r.name)}`}>{r.name}</a></td>
                    <td>
                      <div className="src">
                        <span className="muted" title={r.url}>{r.url ? shortUrl(r.url) : "—"}</span>
                        {r.gitProfile && <span className="tag profile-tag" title={`Cloned with git profile ${r.gitProfile}`}>{r.gitProfile}</span>}
                        {admin && r.url && !active && (
                          <button className="link small" onClick={() => toggle(r.name, "url")}>edit</button>
                        )}
                      </div>
                    </td>
                    <td className="state"><AnalysisStatus repo={r} /></td>
                    <td className="actions">
                      {admin && active && (
                        <button className="secondary" disabled={disabled} onClick={() => cancel(r.name)}>Cancel</button>
                      )}
                      {admin && !active && !r.url && (
                        <button className={r.lastCommit ? "secondary" : ""} onClick={() => toggle(r.name, "url")}>
                          Add git URL
                        </button>
                      )}
                      {admin && !active && r.url && (
                        <button className={r.lastCommit ? "secondary" : ""} disabled={disabled} onClick={() => analyze(r.name)}>
                          {r.analysis?.state === "failed" ? "Retry" : r.lastCommit ? "Re-analyze" : "Analyze"}
                        </button>
                      )}
                      {r.analysis && (
                        <button className="secondary" aria-expanded={open === "log"} onClick={() => toggle(r.name, "log")}>
                          {open === "log" ? "Hide log" : "Log"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="sub">
                      <td colSpan={4}>
                        {open === "log" ? (
                          <AnalysisLog name={r.name} active={active} />
                        ) : (
                          <UrlEditor
                            repo={r}
                            profiles={admin ? profiles : undefined}
                            onAddProfile={addProfile}
                            onDone={(start) => {
                              setPanel(start ? { name: r.name, kind: "log" } : undefined);
                              if (start) analyze(r.name);
                              else reload();
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table></div>
      )}
      {admin && <NewRepo onCreated={reload} profiles={profiles} onAddProfile={addProfile} />}
      {admin && (
        <GitProfilesCard profiles={profilesLoad.data} error={profilesLoad.error} adding={addingProfile}
          setAdding={setAddingProfile} onChange={profilesLoad.reload} />
      )}
      <CliAccess />
    </>
  );
}

function UrlEditor({ repo, onDone, profiles, onAddProfile }: {
  repo: Repo; onDone: (startAnalysis: boolean) => void; profiles?: GitProfile[]; onAddProfile: () => void;
}) {
  const [url, setUrl] = useState(repo.url ?? "");
  const [profile, setProfile] = useState(repo.gitProfile ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(start: boolean) {
    setBusy(true);
    setError("");
    try {
      await api.updateRepo(repo.name, { url: url.trim(), ...(profiles ? { gitProfile: profile } : {}) });
      onDone(start && url.trim() !== "");
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save(true);
      }}
    >
      <label>
        Git URL for {repo.name}
        <div className="row">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
          />
          {profiles && <ProfileSelect profiles={profiles} value={profile} onChange={setProfile} onAddNew={onAddProfile} />}
          <button type="submit" disabled={busy || !url.trim()}>Save and analyze</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => save(false)}>Save</button>
          <button type="button" className="link" onClick={() => onDone(false)}>Cancel</button>
        </div>
      </label>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function NewRepo({ onCreated, profiles, onAddProfile }: {
  onCreated: () => void; profiles: GitProfile[]; onAddProfile: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const repo = await api.createRepo(name.trim(), url.trim(), profile);
      setName("");
      setUrl("");
      if (repo.url) await api.startAnalysis(repo.name);
    } catch (err) {
      setError(errText(err));
    } finally {
      onCreated();
    }
  }

  return (
    <form className="card inline" onSubmit={submit}>
      <h2>Register repository</h2>
      <div className="row">
        <input placeholder="name (e.g. orders-service)" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="git URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <ProfileSelect profiles={profiles} value={profile} onChange={setProfile} onAddNew={onAddProfile} />
        <button type="submit">{url.trim() ? "Add and analyze" : "Add"}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// CliAccess issues an API token for `codeatlas scan`, for repos the server can't clone
// or for indexing every push from CI.
function CliAccess() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function create() {
    setError("");
    try {
      setToken((await api.createToken(`web ${new Date().toISOString().slice(0, 16)}`)).token);
    } catch (e) {
      setError(errText(e));
    }
  }

  const command = `CODEATLAS_URL=${location.origin} CODEATLAS_TOKEN=${token || "<api token>"} \\\n  codeatlas scan . --repo <name>`;
  return (
    <section className="card">
      <h2>Scan from a checkout or CI</h2>
      <p className="muted">
        For repos without a git URL, or to keep the map current on every push. Run this in the repo’s directory.
      </p>
      <pre>{command}</pre>
      {token ? (
        <div className="row center-y">
          <button
            className="secondary"
            onClick={() => navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? "Copied" : "Copy command"}
          </button>
          <span className="muted small">The token is shown only once and acts as you. Keep it secret.</span>
        </div>
      ) : (
        <button onClick={create}>Create API token</button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function shortUrl(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "");
}
