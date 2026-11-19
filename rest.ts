// REST v3 (the GitHub API surface) at /api/v3. Every reply is JSON, carries a non-empty
// X-GitHub-Request-Id, and never leaks an HTML error page. The rules the suite checks
// (program/env/src/checks-rest.ts):
//   - GET  /api/v3/            200 + X-OAuth-Scopes: repo, read:org (no auth needed)
//   - GET  /api/v3/meta        200 {installed_version} non-empty
//   - POST /user/repos         201; a duplicate name is 422 with "already exists" in the message
//   - GET  /user/repos         paginated, Link: <url>; rel="next", same origin, no duplicates
//   - GET/PATCH/DELETE /repos/{owner}/{repo}
//   - POST /repos/{owner}/{repo}/git/refs   201 {ref, object:{sha}}
//   - GET  /repos/{owner}/{repo}/branches, /commits[?sha=]
//   - PUT/GET/DELETE /repos/{owner}/{repo}/contents/{path}
//        PUT create 201 / update 200 / stale sha 409; GET file {encoding:"base64", content, sha, size}
//        or a directory listing; DELETE 200 {commit:{sha}}
//   - POST /repos/{owner}/{repo}/labels     201
//   - POST /repos/{owner}/{repo}/issues     201 open; 422 when a label does not exist
//   - GET  /repos/{owner}/{repo}/issues?state=&sort=created&direction= (open excludes closed)
//   - PATCH /repos/{owner}/{repo}/issues/{n}   closes an issue
//   - POST/GET /repos/{owner}/{repo}/issues/{n}/comments  201 {id, body}
//   - POST /repos/{owner}/{repo}/pulls      201 {number, state:"open", head:{ref,sha}, base:{ref,sha}}
//   - GET  /repos/{owner}/{repo}/pulls/{n}/files  [{filename, status, additions, deletions, changes}]
//   - PUT  /repos/{owner}/{repo}/pulls/{n}/merge {merge_method:"squash"} -> 200 {sha, merged:true, message}
//        the squash commit lands on the default branch with the merged content; unknown PR 404,
//        a conflicting PR 405
//   - Issues and pull requests share one number counter per repo.
//   - A repo under another owner is 404, never 403. Malformed JSON is 400. Unknown routes are
//     404 JSON. The bearer token is MAKEFUN_SHOP_TOKEN; without it, 401.

import {
  buildCommit,
  buildTreeFromPaths,
  commitContents,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  putBlob,
  putObject,
  refCommit,
  repoNodeId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  ZERO_OID,
} from './store.ts';

/** The seeded organisation from the kit's fixed scenario. */
export const ORG_LOGIN = 'faint-meadow-org';

// ---------------------------------------------------------------------------------------------
// views: the JSON shapes the suite (and real clients) read back
// ---------------------------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  baseUrl: string;
  requestId: string;
}

export function repoView(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const owner = repo.owner;
  const isOrg = owner === ORG_LOGIN;
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: isOrg ? 2000 : owner === VIEWER_LOGIN ? VIEWER_ID : 3000, type: isOrg ? 'Organization' : 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `${ctx.baseUrl}/${owner}/${repo.name}`,
    url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueView(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const comments = repo.comments.get(issue.number) ?? [];
  return {
    id: issue.id,
    node_id: repoNodeId(repo),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelView(label) : { name, color: 'ededed', description: '' };
    }),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: comments.length,
    comments_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function commentView(ctx: RestContext, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refCommit(repo, `refs/heads/${pull.baseRef}`);
  return {
    id: pull.id,
    node_id: repoNodeId(repo),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip?.oid ?? pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip?.oid ?? pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** MERGEABLE when no file changed on the head side also changed on the base side since the base. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  return pullFileDiff(repo, pull).conflict === false;
}

/** Compare the merge base against the head and the base tip; list changed files and conflicts. */
export function pullFileDiff(repo: Repo, pull: Pull): {
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  conflict: boolean;
} {
  const headTip = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { files: [], conflict: false };
  const base = mergeBase(repo, headTip.oid, baseTip.oid);
  const basePaths = new Map<string, { oid: string; mode: string }>();
  if (base !== null) {
    const baseObject = repo.objects.get(base);
    if (baseObject !== undefined && baseObject.type === 'commit') {
      flattenTree(repo, parseCommit(baseObject.data).tree, '', basePaths);
    }
  }
  const headPaths = flattenTree(repo, headTip.view.tree);
  const baseTipPaths = flattenTree(repo, baseTip.view.tree);
  const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  let conflict = false;
  const names = new Set([...basePaths.keys(), ...headPaths.keys()]);
  for (const name of [...names].sort()) {
    const from = basePaths.get(name);
    const to = headPaths.get(name);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const status = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    const { additions, deletions } = countLineChanges(repo, from?.oid, to?.oid);
    files.push({ filename: name, status, additions, deletions, changes: additions + deletions });
    // A conflict is a file the head changed that the base tip also changed differently.
    const baseTipEntry = baseTipPaths.get(name);
    const baseChanged = baseTipEntry?.oid !== from?.oid;
    const headChanged = to?.oid !== from?.oid;
    if (baseChanged && headChanged && baseTipEntry?.oid !== to?.oid) conflict = true;
  }
  return { files, conflict };
}

/** Added/deleted line counts between two blob versions (multiset line diff). */
export function countLineChanges(repo: Repo, fromOid: string | undefined, toOid: string | undefined): { additions: number; deletions: number } {
  const linesOf = (oid: string | undefined): string[] => {
    if (oid === undefined) return [];
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const from = linesOf(fromOid);
  const to = linesOf(toOid);
  const fromCount = new Map<string, number>();
  for (const line of from) fromCount.set(line, (fromCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of to) {
    const remaining = fromCount.get(line) ?? 0;
    if (remaining > 0) fromCount.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of fromCount.values()) deletions += remaining;
  return { additions, deletions };
}

/** Squash-merge a pull request onto its base branch; returns the merge commit id or null. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headTip = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const basePaths = flattenTree(repo, baseTip.view.tree);
  const headPaths = flattenTree(repo, headTip.view.tree);
  const base = mergeBase(repo, headTip.oid, baseTip.oid);
  const basePathsOld = new Map<string, { oid: string; mode: string }>();
  if (base !== null) {
    const baseObject = repo.objects.get(base);
    if (baseObject !== undefined && baseObject.type === 'commit') {
      flattenTree(repo, parseCommit(baseObject.data).tree, '', basePathsOld);
    }
  }
  // The merged tree is the base tip's tree with the head's changes applied.
  for (const [name, entry] of headPaths) basePaths.set(name, entry);
  for (const name of basePathsOld.keys()) {
    if (!headPaths.has(name)) basePaths.delete(name);
  }
  const treeOid = buildTreeFromPaths(repo, basePaths);
  const { oid, data } = buildCommit(store, treeOid, [baseTip.oid], `Merge pull request #${pull.number} from ${pull.headRef}`);
  putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  return oid;
}

// ---------------------------------------------------------------------------------------------
// routing and handlers
// ---------------------------------------------------------------------------------------------

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, headers, body };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function parseBody(raw: Buffer | null): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw === null || raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A page of a list, with the Link header GitHub sends for pagination. */
function paginate<T>(ctx: RestContext, path: string, query: URLSearchParams, items: readonly T[]): { page: T[]; link: string | undefined } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | undefined;
  const base = `${ctx.baseUrl}${path}`;
  const other = (key: string, value: string): string => {
    const params = new URLSearchParams(query);
    params.set(key, value);
    return params.toString();
  };
  if (pageNum < totalPages) link = `<${base}?${other('page', String(pageNum + 1))}>; rel="next", <${base}?${other('page', String(totalPages))}>; rel="last"`;
  else if (pageNum > 1) link = `<${base}?${other('page', '1')}>; rel="first", <${base}?${other('page', String(totalPages))}>; rel="last"`;
  return { page, link };
}

function linkHeaders(link: string | undefined): Record<string, string> | undefined {
  return link === undefined ? undefined : { Link: link };
}

/** The repository for a route, or the 404 a repo under another owner also gets. */
function repoOr404(ctx: RestContext, owner: string, name: string): { repo: Repo } | { response: RestResponse } {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return { response: err(404, 'Not Found') };
  return { repo };
}

function decodePath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** List a directory of a tree: GitHub's contents response for a folder. */
function directoryListing(ctx: RestContext, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(object.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    out.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
      download_url: null,
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function handleRest(ctx: RestContext, method: string, segments: string[], query: URLSearchParams, rawBody: Buffer | null): RestResponse {
  // GET /api/v3/ — the root; no auth required, and it carries the OAuth scopes header.
  if (segments.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${ctx.baseUrl}/api/v3/user/repos`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, git_protocol: 'v2' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.viewerRepos();
      const { page, link } = paginate(ctx, '/api/v3/user/repos', query, repos);
      return json(200, page.map((repo) => repoView(ctx, repo)), linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const name = asString(parsed.value.name).trim();
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, asString(parsed.value.description), asBool(parsed.value.private, false));
      if (repo === null) return err(422, `Repository ${name} already exists`);
      return json(201, repoView(ctx, repo));
    }
    return err(405, 'Method Not Allowed');
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }
  if (segments[0] !== 'repos') return err(404, 'Not Found');
  const owner = segments[1] ?? '';
  const repoName = segments[2] ?? '';
  if (owner === '' || repoName === '') return err(404, 'Not Found');
  const found = repoOr404(ctx, owner, repoName);
  if ('response' in found) return found.response;
  const repo = found.repo;
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(ctx, repo));
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') {
        repo.defaultBranch = parsed.value.default_branch;
      }
      repo.updatedAt = ctx.store.nowIso();
      return json(200, repoView(ctx, repo));
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[0] === 'branches') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      branches.push({
        name,
        commit: { sha: oid, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/commits/${oid}` },
        protected: false,
      });
    }
    const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/branches`, query, branches);
    return json(200, page, linkHeaders(link));
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    const sha = query.get('sha') ?? repo.defaultBranch;
    const tip = refCommit(repo, `refs/heads/${sha}`) ?? (isObjectId(sha) ? { oid: sha, view: parseCommit(repo.objects.get(sha)?.data ?? Buffer.alloc(0)) } : undefined);
    if (tip === undefined) return err(404, 'Not Found');
    const commits = ancestorsOf(repo, tip.oid).map((oid) => {
      const object = repo.objects.get(oid);
      const view = object === undefined ? null : parseCommit(object.data);
      return {
        sha: oid,
        commit: {
          message: view?.message ?? '',
          author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: repo.createdAt },
          committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: repo.createdAt },
          tree: { sha: view?.tree ?? '' },
        },
        parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
        url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
      };
    });
    const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/commits`, query, commits);
    return json(200, page, linkHeaders(link));
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      if (!repo.objects.has(sha)) return err(422, `Object ${sha} does not exist`);
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit', url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      return json(200, { ref, object: { sha: oid, type: 'commit' } });
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map(decodePath).join('/');
    const branch = query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = refCommit(repo, `refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const paths = flattenTree(repo, tip.view.tree);
      const entry = paths.get(filePath);
      if (entry !== undefined) {
        const object = repo.objects.get(entry.oid);
        const data = object?.data ?? Buffer.alloc(0);
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: data.toString('base64'),
          sha: entry.oid,
          url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
          html_url: `${ctx.baseUrl}/${owner}/${repoName}/blob/${branch}/${filePath}`,
        });
      }
      // A directory: the entries directly under it.
      const prefix = filePath === '' ? '' : `${filePath}/`;
      const direct = new Set<string>();
      for (const path of paths.keys()) {
        if (!path.startsWith(prefix)) continue;
        const remainder = path.slice(prefix.length);
        if (remainder === '') continue;
        const first = remainder.split('/')[0] as string;
        direct.add(first);
      }
      if (direct.size === 0 && filePath !== '') return err(404, 'Not Found');
      const listing: Record<string, unknown>[] = [];
      for (const name of [...direct].sort()) {
        const path = prefix + name;
        const fileEntry = paths.get(path);
        if (fileEntry !== undefined) {
          const data = repo.objects.get(fileEntry.oid)?.data ?? Buffer.alloc(0);
          listing.push({ type: 'file', name, path, sha: fileEntry.oid, size: data.length, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${path}` });
        } else {
          listing.push({ type: 'dir', name, path, sha: '', size: 0, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${path}` });
        }
      }
      return json(200, listing);
    }
    if (method === 'PUT' || method === 'DELETE') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const message = asString(parsed.value.message) || (method === 'PUT' ? `Update ${filePath}` : `Delete ${filePath}`);
      const targetBranch = asString(parsed.value.branch) || branch;
      const tip = refCommit(repo, `refs/heads/${targetBranch}`);
      const paths = tip === undefined ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, tip.view.tree);
      const existing = paths.get(filePath);
      if (method === 'PUT') {
        const content = asString(parsed.value.content);
        if (content === '') return err(422, 'content is required');
        const data = Buffer.from(content, 'base64');
        const givenSha = asString(parsed.value.sha);
        if (existing !== undefined) {
          if (givenSha === '' || givenSha !== existing.oid) return err(409, 'sha does not match the current file');
        } else if (givenSha !== '') {
          return err(409, 'sha does not match the current file');
        }
        const blobOid = putBlob(repo, data);
        const { commitOid } = commitContents(ctx.store, repo, targetBranch, message, (map) => {
          map.set(filePath, { oid: blobOid, mode: '100644' });
        });
        return json(existing === undefined ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: data.length, encoding: 'base64', content },
          commit: { sha: commitOid, message },
        });
      }
      // DELETE
      if (existing === undefined) return err(404, 'Not Found');
      const givenSha = asString(parsed.value.sha);
      if (givenSha !== '' && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
      const { commitOid } = commitContents(ctx.store, repo, targetBranch, message, (map) => {
        map.delete(filePath);
      });
      return json(200, { commit: { sha: commitOid, message } });
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].map(labelView);
      const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/labels`, query, labels);
      return json(200, page, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const name = asString(parsed.value.name).trim();
      if (name === '') return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `Label ${name} already exists`);
      const label: Label = { name, color: asString(parsed.value.color) || 'ededed', description: asString(parsed.value.description) };
      repo.labels.set(name, label);
      return json(201, labelView(label));
    }
    return err(405, 'Method Not Allowed');
  }

  if (rest[0] === 'issues') {
    const number = rest[1] === undefined ? null : Number.parseInt(rest[1], 10);
    if (number === null) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => (sort === 'created' ? a.seq - b.seq : a.number - b.number));
        if (direction === 'desc') issues.reverse();
        const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/issues`, query, issues);
        return json(200, page.map((issue) => issueView(ctx, repo, issue)), linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        const title = asString(parsed.value.title).trim();
        if (title === '') return err(422, 'title is required');
        const labels: string[] = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        for (const name of labels) {
          if (!repo.labels.has(name)) return err(422, `Label ${name} does not exist`);
        }
        const at = ctx.store.nowIso();
        const issueNumber = repo.nextNumber;
        repo.nextNumber += 1;
        const issue: Issue = {
          id: ctx.store.nextGlobalId(),
          number: issueNumber,
          title,
          body: asString(parsed.value.body),
          state: 'open',
          labels,
          seq: issueNumber,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
        };
        repo.issues.set(issueNumber, issue);
        repo.comments.set(issueNumber, []);
        return json(201, issueView(ctx, repo, issue));
      }
      return err(405, 'Method Not Allowed');
    }
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    if (rest[2] === 'comments') {
      if (method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/issues/${number}/comments`, query, comments);
        return json(200, page.map((comment) => commentView(ctx, repo, issue, comment)), linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        const body = asString(parsed.value.body).trim();
        if (body === '') return err(422, 'body is required');
        const at = ctx.store.nowIso();
        const comment: Comment = { id: ctx.store.nextGlobalId(), body, createdAt: at, updatedAt: at };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return json(201, commentView(ctx, repo, issue, comment));
      }
      return err(405, 'Method Not Allowed');
    }
    if (rest.length === 2) {
      if (method === 'GET') return json(200, issueView(ctx, repo, issue));
      if (method === 'PATCH') {
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
          issue.state = parsed.value.state;
          issue.closedAt = issue.state === 'closed' ? ctx.store.nowIso() : null;
        }
        issue.updatedAt = ctx.store.nowIso();
        return json(200, issueView(ctx, repo, issue));
      }
      return err(405, 'Method Not Allowed');
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    const number = rest[1] === undefined ? null : Number.parseInt(rest[1], 10);
    if (number === null) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(ctx, `/api/v3/repos/${owner}/${repoName}/pulls`, query, pulls);
        return json(200, page.map((pull) => pullView(ctx, repo, pull)), linkHeaders(link));
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        const title = asString(parsed.value.title).trim();
        const head = asString(parsed.value.head).trim();
        const base = asString(parsed.value.base).trim();
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const headTip = refCommit(repo, `refs/heads/${head}`);
        const baseTip = refCommit(repo, `refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) return err(422, 'head or base branch does not exist');
        const at = ctx.store.nowIso();
        const pullNumber = repo.nextNumber;
        repo.nextNumber += 1;
        const pull: Pull = {
          id: ctx.store.nextGlobalId(),
          number: pullNumber,
          title,
          body: asString(parsed.value.body),
          state: 'open',
          headRef: head,
          baseRef: base,
          headSha: headTip.oid,
          baseSha: baseTip.oid,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          mergeable: true,
          seq: pullNumber,
          createdAt: at,
          updatedAt: at,
        };
        pull.mergeable = pullMergeable(repo, pull);
        repo.pulls.set(pullNumber, pull);
        return json(201, pullView(ctx, repo, pull));
      }
      return err(405, 'Method Not Allowed');
    }
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, 'Not Found');
    if (rest[2] === 'files') {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      return json(200, pullFileDiff(repo, pull).files);
    }
    if (rest[2] === 'merge') {
      if (method !== 'PUT') return err(405, 'Method Not Allowed');
      const parsed = parseBody(rawBody);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged or closed');
      const mergeMethod = asString(parsed.value.merge_method) || 'squash';
      if (mergeMethod !== 'squash') return err(405, 'Only squash merges are supported');
      if (!pullMergeable(repo, pull)) return err(405, 'Pull request is not mergeable');
      const sha = squashMerge(ctx.store, repo, pull);
      if (sha === null) return err(405, 'Pull request cannot be merged');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = ctx.store.nowIso();
      pull.mergeCommitSha = sha;
      pull.updatedAt = ctx.store.nowIso();
      return json(200, { sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
    }
    if (rest.length === 2) {
      if (method === 'GET') return json(200, pullView(ctx, repo, pull));
      if (method === 'PATCH') {
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
        if (parsed.value.state === 'closed' || parsed.value.state === 'open') pull.state = parsed.value.state;
        pull.updatedAt = ctx.store.nowIso();
        return json(200, pullView(ctx, repo, pull));
      }
      return err(405, 'Method Not Allowed');
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
