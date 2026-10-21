// Typed client for the CodeAtlas core API. Auth rides on the HttpOnly session cookie.

export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Repo {
  id: string;
  name: string;
  url?: string;
  defaultBranch: string;
  createdAt: string;
  lastCommit?: string; // latest uploaded snapshot
  analyzedAt?: string;
  analysis?: AnalysisJob; // latest server-side run since the server started
  gitProfile?: string; // the git profile whose SSH key clones it
}

/** A git profile on the server (the same ~/.git-profiles the terminal helper uses). */
export interface GitProfile {
  name: string;
  userName: string;
  email: string;
  keyPath: string;
  keyExists: boolean;
  publicKey?: string;
}

export interface NewGitProfile {
  name: string;
  userName: string;
  email: string;
  generateKey: boolean;
  keyPath?: string;
}

export type AnalysisState = "queued" | "cloning" | "analyzing" | "succeeded" | "failed" | "canceled";

export interface AnalysisJob {
  repo: string;
  state: AnalysisState;
  commit?: string;
  branch?: string;
  stored: string[];
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  log?: string[];
}

export const isActive = (j?: AnalysisJob) =>
  j?.state === "queued" || j?.state === "cloning" || j?.state === "analyzing";

export interface Snapshot {
  id: string;
  repoId: string;
  commit: string;
  branch?: string;
  analyzer: string;
  analyzerVersion: string;
  irVersion: string;
  createdAt: string;
  nodeCount: number;
  edgeCount: number;
}

export interface SourceLocation {
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  parent?: string;
  language?: string;
  location?: SourceLocation;
  otel?: Record<string, string>;
  attrs?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  locations?: SourceLocation[];
  attrs?: Record<string, unknown>;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Commit {
  commit: string;
  branch?: string;
  analyzers: string[];
  uploadedAt: string;
}

export interface RepoGraph extends Graph {
  commit: string;
  snapshots: Snapshot[];
  /** The repo's .codeatlas.yml as uploaded with this commit. */
  config?: RepoConfig;
}

/** Diagram grouping settings from the repo itself (.codeatlas.yml). */
export interface RepoConfig {
  groups?: { name: string; members: string[] }[];
  rename?: Record<string, string>;
}

/**
 * Grouping edits: group id -> label (same labels merge), graph node id -> group name, and the
 * names given to the all-layers detail levels (default level name -> name).
 */
export interface GroupOverrides {
  rename: Record<string, string>;
  assign: Record<string, string>;
  levels?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    // Always JSON: the API rejects cookie-authenticated writes without it (CSRF guard).
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? res.statusText);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  login: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/v1/auth/login", { email, password }),
  logout: () => request<void>("POST", "/api/v1/auth/logout"),
  me: () => request<User>("GET", "/api/v1/me"),
  repos: () => request<Repo[]>("GET", "/api/v1/repos"),
  createRepo: (name: string, url: string, gitProfile = "") => request<Repo>("POST", "/api/v1/repos", { name, url, gitProfile }),
  repo: (name: string) => request<Repo>("GET", `/api/v1/repos/${enc(name)}`),
  updateRepo: (name: string, patch: { url?: string; defaultBranch?: string; gitProfile?: string }) =>
    request<Repo>("PATCH", `/api/v1/repos/${enc(name)}`, patch),
  analysis: (repo: string) => request<AnalysisJob>("GET", `/api/v1/repos/${enc(repo)}/analysis`),
  startAnalysis: (repo: string) => request<AnalysisJob>("POST", `/api/v1/repos/${enc(repo)}/analysis`),
  cancelAnalysis: (repo: string) => request<void>("DELETE", `/api/v1/repos/${enc(repo)}/analysis`),
  gitProfiles: () => request<GitProfile[]>("GET", "/api/v1/git-profiles"),
  createGitProfile: (p: NewGitProfile) => request<GitProfile>("POST", "/api/v1/git-profiles", p),
  testGitProfile: (name: string) =>
    request<{ ok: boolean; account: string; message: string }>("POST", `/api/v1/git-profiles/${enc(name)}/test`),
  groups: (repo: string) => request<GroupOverrides>("GET", `/api/v1/repos/${enc(repo)}/groups`),
  setGroups: (repo: string, o: GroupOverrides) => request<GroupOverrides>("PUT", `/api/v1/repos/${enc(repo)}/groups`, o),
  createToken: (name: string) => request<{ name: string; token: string }>("POST", "/api/v1/tokens", { name }),
  snapshots: (repo: string) => request<Snapshot[]>("GET", `/api/v1/repos/${enc(repo)}/snapshots`),
  graph: (snapshotId: string) => request<Graph>("GET", `/api/v1/snapshots/${enc(snapshotId)}/graph`),
  commits: (repo: string) => request<Commit[]>("GET", `/api/v1/repos/${enc(repo)}/commits`),
  repoGraph: (repo: string, commit?: string) =>
    request<RepoGraph>("GET", `/api/v1/repos/${enc(repo)}/graph${commit ? `?commit=${enc(commit)}` : ""}`),
};
