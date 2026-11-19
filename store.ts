// The forge's in-memory store: repositories, issues, pull requests, labels and the git
// object database. Everything lives in Maps; nothing touches the filesystem, so a trial
// starts empty and stays fast. Determinism is a design rule here, not an accident: every
// id, number and timestamp comes from a counter that only moves when a request moves it,
// so two runs that receive the same requests in the same order produce byte-identical
// state (the final's replay compares the exports). No Date.now(), no Math.random(), no
// UUID anywhere in this file.
//
// The viewer is the login the trial's bearer token names. The suite's scenario is fixed
// by the kit's sealed wire.ts (SCENARIO_SEED), so that login is the same in every trial;
// it is written down here from the kit's published scenario, not guessed.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

/** A fixed epoch the deterministic clock starts from (2025-01-01T00:00:00Z). */
const CLOCK_EPOCH_SEC = 1_735_689_600;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  /** The global numeric id, stable across reads (the REST `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Creation order, for CREATED_AT sorts; strictly increasing per repository. */
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  labels: Map<string, Label>;
  /** One counter for issues and pull requests, as GitHub numbers them together. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

/** The whole forge: every repository, and the counters that make ids deterministic. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private clock = 0;

  /** A deterministic timestamp: one second per call, from a fixed epoch. */
  nowIso(): string {
    this.clock += 1;
    return new Date((CLOCK_EPOCH_SEC + this.clock) * 1000).toISOString();
  }

  /** A deterministic Unix timestamp (seconds) for a git commit object. */
  nowSec(): number {
    this.clock += 1;
    return CLOCK_EPOCH_SEC + this.clock;
  }

  nextGlobalId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Create a repository; null when that owner/name already exists. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const at = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      labels: new Map(),
      nextNumber: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// git object ids and object parsing
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The commit object bytes for a tree, parents, message and timestamp. */
export function buildCommit(store: Store, tree: string, parents: readonly string[], message: string): { oid: string; data: Buffer } {
  const ts = store.nowSec();
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const text = `${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`;
  const data = Buffer.from(text, 'utf8');
  return { oid: hashObject('commit', data), data };
}

// ---------------------------------------------------------------------------------------------
// object store helpers
// ---------------------------------------------------------------------------------------------

/** Store an object in a repository, returning its id (an existing object is kept as-is). */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The commit a ref points at, or undefined when the ref is missing or points elsewhere. */
export function refCommit(repo: Repo, ref: string): { oid: string; view: CommitView } | undefined {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return undefined;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return { oid, view: parseCommit(object.data) };
}

/** Every object reachable from `roots`: commit -> tree + parents, tag -> target, tree -> entries. */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The ancestors of a commit, itself included, newest first (parents before grandparents). */
export function ancestorsOf(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(repo, descendant).includes(ancestor);
}

/** The first commit reachable from both tips (the merge base), or null when they share none. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAncestors = new Set(ancestorsOf(repo, b));
  for (const oid of ancestorsOf(repo, a)) {
    if (bAncestors.has(oid)) return oid;
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode}, following nested directories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out: Map<string, { oid: string; mode: string }> = new Map()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

interface TreeNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, TreeNode>;
}

/** Build trees bottom-up from a path map, storing every tree object; returns the root tree id. */
export function buildTreeFromPaths(repo: Repo, paths: ReadonlyMap<string, { oid: string; mode: string }>): string {
  const make = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of paths) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as TreeNode;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The blob id for bytes, stored in the repository. */
export function putBlob(repo: Repo, data: Buffer): string {
  return putObject(repo, 'blob', data);
}

/** Commit one contents change on a branch: apply `change` to the branch tip's tree and commit it. */
export function commitContents(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  change: (paths: Map<string, { oid: string; mode: string }>) => void,
): { commitOid: string; treeOid: string } {
  const tip = refCommit(repo, `refs/heads/${branch}`);
  const paths = tip === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, tip.view.tree);
  change(paths);
  const treeOid = buildTreeFromPaths(repo, paths);
  const parents = tip === undefined ? [] : [tip.oid];
  const { oid, data } = buildCommit(store, treeOid, parents, message);
  putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return { commitOid: oid, treeOid };
}

/** The file map of a ref's tip, or an empty map when the ref is unborn. */
export function refPaths(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
  const tip = refCommit(repo, ref);
  if (tip === undefined) return new Map();
  return flattenTree(repo, tip.view.tree);
}

// ---------------------------------------------------------------------------------------------
// Relay (GraphQL) global ids: opaque, stable, never the plain database id or number.
// ---------------------------------------------------------------------------------------------

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export function repoNodeId(repo: Repo): string {
  return b64(`Repository:${repo.id}`);
}

export function issueNodeId(repo: Repo, number: number): string {
  return b64(`Issue:${repo.id}:${number}`);
}

export function pullNodeId(repo: Repo, number: number): string {
  return b64(`PullRequest:${repo.id}:${number}`);
}

export function commentNodeId(id: number): string {
  return b64(`IssueComment:${id}`);
}

/** Decode a Relay id into its kind and parts, or null when it is not one of ours. */
export function decodeNodeId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
  return { kind, parts: parts.slice(1) };
}

/** Find a repository by its numeric database id. */
export function repoByDatabaseId(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}
