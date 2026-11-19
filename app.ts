// The forge's HTTP server: one in-memory store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP), and a health probe. The lifecycle in main.ts owns the process; this file
// owns the wire.
//
// Determinism note: the request id is a counter (req-1, req-2, ...), never a random value,
// so two runs that receive the same requests produce the same replies. The bearer token is
// MAKEFUN_SHOP_TOKEN: when it is set, the Bearer must match it exactly; when it is unset
// (local development), any non-empty Bearer is accepted. A missing token is always 401.
// Public without auth: GET /healthz, GET /api/v3/ (root) and GET /api/v3/meta. Everything
// else — REST, GraphQL, MCP and the git endpoints — requires the token.
//
// Routing order: healthz -> /api/v3 -> /api/graphql -> /mcp -> /{owner}/{repo}.git -> 404 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleAdvertise, handleReceivePack, handleUploadPack, type GitResponse } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestContext, type RestResponse } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Read the request body, capped at 64 MB; null when there is no body at all. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let seen = false;
    req.on('data', (chunk: Buffer) => {
      seen = true;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(seen ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

/** The Bearer token of the request, or null when the Authorization header is absent. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The origin the entry is reached on, for absolute pagination links and html_urls. */
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------------------------
// replies
// ---------------------------------------------------------------------------------------------

/** Answer with a JSON body; every reply carries a non-empty X-GitHub-Request-Id. */
function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...extraHeaders,
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

/** Answer with raw bytes (a git advertisement, fetch, or push report). */
function sendBytes(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendRest(res: ServerResponse, requestId: string, response: RestResponse): void {
  sendJson(res, requestId, response.status, response.body, response.headers ?? {});
}

function sendGit(res: ServerResponse, requestId: string, response: GitResponse): void {
  if (response.contentType === 'application/json') {
    sendJson(res, requestId, response.status, JSON.parse(response.body.toString('utf8')));
    return;
  }
  sendBytes(res, requestId, response.status, response.contentType, response.body);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const baseUrl = baseUrlOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, requestId, 200, { ok: true });
        return;
      }

      // REST v3: the root and /meta are public; everything else needs the bearer token.
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((part) => part !== '');
        const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
        if (!isPublic && !isAuthorized(req)) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        let body: Buffer | null = null;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, requestId, 413, { message: 'Request body is too large' });
          return;
        }
        const ctx: RestContext = { store, baseUrl, requestId };
        sendRest(res, requestId, handleRest(ctx, method, segments, query, body));
        return;
      }

      // GraphQL v4: always authenticated.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        let body: Buffer | null = null;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, requestId, 413, { message: 'Request body is too large' });
          return;
        }
        const result = handleGraphQL({ store, baseUrl }, body);
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // MCP: always authenticated.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        let body: Buffer | null = null;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, requestId, 413, { message: 'Request body is too large' });
          return;
        }
        const result = handleMcp(store, baseUrl, body);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const action = gitMatch[3] as string;
        if (!isAuthorized(req)) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }
        if (action === 'info/refs') {
          if (method !== 'GET') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const service = query.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, requestId, 400, { message: 'service is required' });
            return;
          }
          const isV2 = req.headers['git-protocol'] === 'version=2';
          sendGit(res, requestId, handleAdvertise(repo, service, isV2));
          return;
        }
        let body: Buffer | null = null;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, requestId, 413, { message: 'Request body is too large' });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (action === 'git-upload-pack') {
          const isV2 = req.headers['git-protocol'] === 'version=2';
          sendGit(res, requestId, handleUploadPack(repo, body ?? Buffer.alloc(0), isV2));
          return;
        }
        sendGit(res, requestId, handleReceivePack(repo, body ?? Buffer.alloc(0)));
        return;
      }

      // Everything else, every method: GitHub's 404 body, as JSON.
      sendJson(res, requestId, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      // A handler must never hang the connection: answer 500 JSON and log the cause.
      try {
        if (!res.headersSent) sendJson(res, `req-${requestCounter}`, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
      process.stderr.write(`[forge] request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    });
  });
}
