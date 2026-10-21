import { FormEvent, useState } from "react";
import { api, GitProfile } from "../api";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const ADD_PROFILE = "__add__";

/** Which git profile clones a repo; the last option opens the "add profile" form. */
export function ProfileSelect({ profiles, value, onChange, onAddNew }: {
  profiles: GitProfile[]; value: string; onChange: (name: string) => void; onAddNew: () => void;
}) {
  return (
    <select className="profile-select" value={value} aria-label="Git profile"
      title="Which git profile's SSH key the server clones this repo with"
      onChange={(e) => (e.target.value === ADD_PROFILE ? onAddNew() : onChange(e.target.value))}>
      <option value="">Server default credentials</option>
      {profiles.map((p) => (
        <option key={p.name} value={p.name} disabled={!p.keyExists}>
          {p.name} · {p.email}{p.keyExists ? "" : " (key missing)"}
        </option>
      ))}
      <option value={ADD_PROFILE}>+ Add a git profile…</option>
    </select>
  );
}

/**
 * The server's git profiles: who each one commits as and which SSH key it authenticates
 * with, a login test against GitHub, and a form to add one (with a new key or an existing one).
 */
export function GitProfilesCard({ profiles, error, adding, setAdding, onChange }: {
  profiles?: GitProfile[]; error: string; adding: boolean; setAdding: (b: boolean) => void; onChange: () => void;
}) {
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "running">>({});
  const [created, setCreated] = useState<GitProfile>();

  async function test(name: string) {
    setTests((t) => ({ ...t, [name]: "running" }));
    try {
      const r = await api.testGitProfile(name);
      setTests((t) => ({ ...t, [name]: { ok: r.ok, text: r.ok ? `logs in to GitHub as ${r.account}` : r.message || "not accepted" } }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, text: errText(e) } }));
    }
  }

  return (
    <section className="card" id="git-profiles">
      <div className="page-head">
        <h2>Git profiles</h2>
        {!adding && <button className="secondary" onClick={() => { setCreated(undefined); setAdding(true); }}>Add profile</button>}
      </div>
      <p className="muted">
        The SSH key the server clones a repo with. These are the same profiles as <code>gitprofile</code> in your
        terminal (<code>~/.git-profiles</code> on the server). Private keys never leave the server.
      </p>
      {error && <p className="error">{error}</p>}
      {profiles && profiles.length === 0 && !adding && <p className="muted">No profiles yet.</p>}
      {profiles && profiles.length > 0 && (
        <div className="table-wrap"><table className="profiles">
          <thead><tr><th>Profile</th><th>Commits as</th><th>SSH key</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {profiles.map((p) => {
              const t = tests[p.name];
              return (
                <tr key={p.name}>
                  <td><strong>{p.name}</strong></td>
                  <td>{p.userName} <span className="muted">&lt;{p.email}&gt;</span></td>
                  <td>
                    <code className="small">{p.keyPath}</code>
                    {!p.keyExists && <span className="error small"> missing</span>}
                    {t && t !== "running" && <span className={`small test-result ${t.ok ? "ok" : "error"}`}>{t.ok ? "✓ " : "✕ "}{t.text}</span>}
                  </td>
                  <td className="actions">
                    {p.publicKey && <CopyButton text={p.publicKey} label="Copy public key" />}
                    <button className="secondary" disabled={!p.keyExists || t === "running"} onClick={() => test(p.name)}>
                      {t === "running" ? "Testing…" : "Test"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {adding && (
        <AddProfile
          onCancel={() => setAdding(false)}
          onCreated={(p) => { setCreated(p); setAdding(false); onChange(); }}
        />
      )}
      {created && (
        <div className="created-profile">
          <p>
            <strong>Profile “{created.name}” added.</strong> Add this public key to the GitHub account that{" "}
            {created.email} belongs to, then press Test above.
          </p>
          {created.publicKey && <pre className="pubkey">{created.publicKey}</pre>}
          <div className="row center-y">
            {created.publicKey && <CopyButton text={created.publicKey} label="Copy public key" />}
            <a className="button-link" href="https://github.com/settings/ssh/new" target="_blank" rel="noreferrer">
              Open GitHub SSH settings ↗
            </a>
            <button className="link small" onClick={() => setCreated(undefined)}>Done</button>
          </div>
        </div>
      )}
    </section>
  );
}

function AddProfile({ onCancel, onCreated }: { onCancel: () => void; onCreated: (p: GitProfile) => void }) {
  const [name, setName] = useState("");
  const [userName, setUserName] = useState("");
  const [email, setEmail] = useState("");
  const [generate, setGenerate] = useState(true);
  const [keyPath, setKeyPath] = useState("~/.ssh/");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(await api.createGitProfile({ name: name.trim(), userName: userName.trim(), email: email.trim(), generateKey: generate, keyPath: generate ? undefined : keyPath.trim() }));
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="add-profile" onSubmit={submit}>
      <h3>New git profile</h3>
      <div className="row">
        <input placeholder="profile (e.g. client-x)" value={name} onChange={(e) => setName(e.target.value)} required autoFocus aria-label="Profile name" />
        <input placeholder="your name" value={userName} onChange={(e) => setUserName(e.target.value)} required aria-label="Your name" />
        <input type="email" placeholder="email of that GitHub account" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
      </div>
      <fieldset className="key-choice">
        <label className="check">
          <input type="radio" name="key" checked={generate} onChange={() => setGenerate(true)} />
          Generate a new SSH key <span className="muted small">(~/.ssh/id_ed25519_{name.trim().toLowerCase() || "<profile>"}, no passphrase)</span>
        </label>
        <label className="check">
          <input type="radio" name="key" checked={!generate} onChange={() => setGenerate(false)} />
          Use an existing key in ~/.ssh
        </label>
        {!generate && (
          <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519_work" aria-label="Existing private key path" />
        )}
      </fieldset>
      <div className="row center-y">
        <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add profile"}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="secondary" type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
      {copied ? "Copied" : label}
    </button>
  );
}
