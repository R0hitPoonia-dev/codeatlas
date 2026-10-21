import { useEffect, useRef, useState } from "react";
import { AnalysisJob, api, isActive, Repo } from "../api";

const STEP: Record<string, string> = { queued: "Queued", cloning: "Cloning", analyzing: "Analyzing" };

// AnalysisStatus summarises a repo's latest stored analysis and any server-side run.
export function AnalysisStatus({ repo }: { repo: Repo }) {
  const j = repo.analysis;
  if (isActive(j)) {
    return (
      <span className="status running">
        <span className="dot" aria-hidden />
        {STEP[j!.state]}…<span className="muted">{elapsed(j!)}</span>
      </span>
    );
  }
  const done = repo.lastCommit && (
    <span className="status ok">
      <span aria-hidden>✓</span> <code>{repo.lastCommit.slice(0, 10)}</code>
      <span className="muted">· {ago(repo.analyzedAt)}</span>
    </span>
  );
  if (j?.state === "failed") {
    const hint = failureHint(j.error);
    return (
      <>
        {done}
        <span className="status failed" title={j.error}>{done ? "Last run failed" : "Failed"}: {j.error}</span>
        {hint && <span className="hint">{hint}</span>}
      </>
    );
  }
  if (done) return done;
  return <span className="muted">{j?.state === "canceled" ? "Canceled · not analyzed" : "Not analyzed yet"}</span>;
}

// AnalysisLog shows the output of the repo's latest run, following it while active.
export function AnalysisLog({ name, active }: { name: string; active: boolean }) {
  const [job, setJob] = useState<AnalysisJob>();
  const [error, setError] = useState("");
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.analysis(name).then(
        (j) => live && (setJob(j), setError("")),
        (e) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    load(); // runs once more when the job finishes, to get the final lines
    const t = active ? setInterval(load, 1500) : undefined;
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [name, active]);

  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [job?.log?.length]);

  if (error) return <p className="muted small">{error}</p>;
  if (!job) return <p className="muted small">Loading log…</p>;
  return (
    <pre ref={pre} className="log" aria-live="polite">
      {job.log?.length ? job.log.join("\n") : "No output yet."}
    </pre>
  );
}

function failureHint(error = ""): string {
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/i.test(error)) {
    return "The server has no credentials for this repo. Pick a git profile for it (edit → Git profile), or restart the server with CODEATLAS_GIT_TOKEN set.";
  }
  if (/repository .*not found|does not exist|not a git repository/i.test(error)) {
    return "Check the git URL. Private GitHub repos also report “not found” when the server has no token (CODEATLAS_GIT_TOKEN).";
  }
  if (/analyzer.* not found|not found; set CODEATLAS_/i.test(error)) {
    return "Analyzers are missing on the server. Run make build so they sit next to codeatlas-api.";
  }
  return "";
}

function elapsed(j: AnalysisJob): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(j.startedAt ?? j.queuedAt)) / 1000));
  return ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ago(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
