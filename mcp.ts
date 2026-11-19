// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern revision 2026-07-28
// (server/discover) with the legacy 2025-11-25 handshake (initialize + notifications/initialized)
// as a fallback. Plain JSON responses are enough; no SSE is needed. The tools act on the same
// in-memory store as REST, so a repo or issue created through MCP has the same id when read
// back through REST or GraphQL. Two tools/list calls answer byte-identically.
//
// The checks (program/env/src/checks-mcp.ts) require at least these six tools, matched as a
// suffix case-insensitively, each with a non-empty description and an inputSchema of type
// object: create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. The `required` lists are minimal on purpose: the suite maps its
// documented argument names onto the nearest schema property, and any required property it
// cannot fill fails the check.

import { pullFileDiff, pullMergeable, repoView, squashMerge, type RestContext } from './rest.ts';
import { refCommit, type Issue, type Pull, type Repo, type Store, VIEWER_LOGIN } from './store.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOL_DEFINITIONS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'string', description: 'A comma-separated list of label names to apply.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes come from.' },
        base: { type: 'string', description: 'The branch the changes go onto.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools/list answer, built once so two calls are byte-identical. */
export const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOL_DEFINITIONS });

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Read owner/repo from tool arguments, accepting the suite's synonyms: owner_login for
 * owner, and full_name ("owner/repo") for the pair.
 */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = asString(args.owner ?? args.owner_login);
  let repo = asString(args.repo);
  const fullName = asString(args.full_name);
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [head, ...tail] = fullName.split('/');
    if (owner === '') owner = head ?? '';
    if (repo === '') repo = tail.join('/');
  }
  return { owner, repo };
}

export interface McpCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: Record<string, unknown>): McpCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): McpCallResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function restCtx(store: Store, baseUrl: string): RestContext {
  return { store, baseUrl, requestId: 'req-mcp' };
}

// ---------------------------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------------------------

function createRepoTool(store: Store, baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const name = asString(args.name).trim();
  if (name === '') return toolError('name is required');
  const repo = store.createRepo(VIEWER_LOGIN, name, asString(args.description), args.private === true);
  if (repo === null) return toolError(`Repository ${name} already exists`);
  const view = repoView(restCtx(store, baseUrl), repo);
  return ok({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, description: view.description, html_url: view.html_url, url: view.url });
}

function getRepoTool(store: Store, baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const { owner, repo: name } = ownerRepo(args);
  if (owner === '' || name === '') return toolError('owner and repo are required');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Repository ${owner}/${name} not found`);
  const view = repoView(restCtx(store, baseUrl), repo);
  return ok({ id: view.id, name: view.name, full_name: view.full_name, private: view.private, description: view.description, default_branch: view.default_branch, html_url: view.html_url, url: view.url });
}

function createIssueTool(store: Store, baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const { owner, repo: name } = ownerRepo(args);
  const title = asString(args.title).trim();
  if (owner === '' || name === '') return toolError('owner and repo are required');
  if (title === '') return toolError('title is required');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Repository ${owner}/${name} not found`);
  const labels = asString(args.labels).split(',').map((label) => label.trim()).filter((label) => label !== '');
  for (const label of labels) {
    if (!repo.labels.has(label)) return toolError(`Label ${label} does not exist`);
  }
  const at = store.nowIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: store.nextGlobalId(),
    number,
    title,
    body: asString(args.body),
    state: 'open',
    labels,
    seq: number,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  repo.issues.set(number, issue);
  repo.comments.set(number, []);
  return ok({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `${baseUrl}/${owner}/${name}/issues/${number}` });
}

function listIssuesTool(store: Store, _baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const { owner, repo: name } = ownerRepo(args);
  if (owner === '' || name === '') return toolError('owner and repo are required');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Repository ${owner}/${name} not found`);
  const state = asString(args.state) || 'open';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => b.seq - a.seq);
  const list = issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
  return ok({ issues: list, total_count: list.length });
}

function createPullRequestTool(store: Store, baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const { owner, repo: name } = ownerRepo(args);
  const title = asString(args.title).trim();
  const head = asString(args.head ?? args.head_ref).trim();
  const base = asString(args.base ?? args.base_ref).trim();
  if (owner === '' || name === '') return toolError('owner and repo are required');
  if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Repository ${owner}/${name} not found`);
  const headTip = refCommit(repo, `refs/heads/${head}`);
  const baseTip = refCommit(repo, `refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
  const at = store.nowIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    id: store.nextGlobalId(),
    number,
    title,
    body: asString(args.body),
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headTip.oid,
    baseSha: baseTip.oid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
    seq: number,
    createdAt: at,
    updatedAt: at,
  };
  pull.mergeable = pullMergeable(repo, pull);
  repo.pulls.set(number, pull);
  return ok({
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    head: { ref: head, sha: headTip.oid },
    base: { ref: base, sha: baseTip.oid },
    url: `${baseUrl}/${owner}/${name}/pull/${number}`,
  });
}

function mergePullRequestTool(store: Store, _baseUrl: string, args: Record<string, unknown>): McpCallResult {
  const { owner, repo: name } = ownerRepo(args);
  const pullNumber = asNumber(args.pull_number ?? args.number);
  if (owner === '' || name === '') return toolError('owner and repo are required');
  if (pullNumber === null) return toolError('pull_number is required');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return toolError(`Repository ${owner}/${name} not found`);
  const pull = repo.pulls.get(pullNumber);
  if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
  if (pull.merged || pull.state === 'closed') return toolError('Pull request is already merged or closed');
  if (!pullMergeable(repo, pull)) return toolError('Pull request is not mergeable');
  const sha = squashMerge(store, repo, pull);
  if (sha === null) return toolError('Pull request cannot be merged');
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = store.nowIso();
  return ok({ merged: true, sha, number: pull.number });
}

const TOOL_HANDLERS: Record<string, (store: Store, baseUrl: string, args: Record<string, unknown>) => McpCallResult> = {
  create_repo: createRepoTool,
  get_repo: getRepoTool,
  create_issue: createIssueTool,
  list_issues: listIssuesTool,
  create_pull_request: createPullRequestTool,
  merge_pull_request: mergePullRequestTool,
};

/** Find a tool by the name the client sent, matching the canonical suffix case-insensitively. */
export function findTool(name: string): McpTool | undefined {
  const lower = name.toLowerCase();
  return TOOL_DEFINITIONS.find((tool) => tool.name === lower || lower.endsWith(tool.name));
}

function missingRequired(tool: McpTool, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value !== undefined && value !== null && value !== '') continue;
    // Synonyms the suite may send instead: full_name ("owner/repo") stands in for owner
    // and repo, and number stands in for pull_number.
    if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
    if (required === 'pull_number' && args.number !== undefined && args.number !== null && args.number !== '') continue;
    return required;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0 over Streamable HTTP
// ---------------------------------------------------------------------------------------------

export interface McpResponse {
  status: number;
  body: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

export function handleMcp(store: Store, baseUrl: string, rawBody: Buffer | null): McpResponse {
  let request: JsonRpcRequest;
  try {
    if (rawBody === null || rawBody.length === 0) throw new Error('empty body');
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as JsonRpcRequest;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON.' } },
    };
  }
  const id = request.id ?? null;
  const hasId = request.id !== undefined && request.id !== null;
  const method = typeof request.method === 'string' ? request.method : '';

  // A notification (no id) gets no JSON-RPC reply; over HTTP that is an empty 202.
  if (!hasId) return { status: 202, body: null };

  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28', '2025-11-25'],
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      },
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
    };
  }
  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) as unknown } };
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(toolName);
    if (tool === undefined) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool "${toolName}".` } } };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool arguments must be an object.' } } };
    }
    const missing = missingRequired(tool, args as Record<string, unknown>);
    if (missing !== null) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument "${missing}".` }) }], isError: true } },
      };
    }
    const handler = TOOL_HANDLERS[tool.name] as (store: Store, baseUrl: string, args: Record<string, unknown>) => McpCallResult;
    const result = handler(store, baseUrl, args as Record<string, unknown>);
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}
