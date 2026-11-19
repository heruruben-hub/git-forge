// git smart HTTP: upload-pack protocol v2 (and the v0 fallback), receive-pack v0, and
// the packfile reader/writer. No git binary anywhere: every byte is built here from the
// object store in store.ts, on node:zlib and node:crypto alone.
//
// The wire the suite speaks (program/env/src/git-client.ts):
//   - GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//        with Git-Protocol: version=2  -> v2 capability advertisement ("version 2" first)
//        without it                     -> v0 ref advertisement ("# service=..." first)
//   - POST /{owner}/{repo}.git/git-upload-pack
//        v2: command=ls-refs | command=fetch, arguments after a delim packet
//        v0: want/have/shallow/deepen lines in two sections split by a flush
//   - GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack -> v0 advertisement
//   - POST /{owner}/{repo}.git/git-receive-pack
//        command lines, flush, then the raw pack; answered with a sideband report-status
//
// A pack the server sends carries plain objects only, no deltas: the suite's pack-deltas
// check accepts that (it verifies whatever arrives), and a self-contained pack is what
// a thin-pack request still accepts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';
import {
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  refCommit,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
  ZERO_OID,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export type PktItem = string | Buffer | 'flush' | 'delim' | 'response-end';

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** One decoded packet: a data payload, or a control packet. */
export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; throws on a malformed header or truncation. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split one sideband payload into band-1 data chunks (band 2 is progress, band 3 an error). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const chunk = data.subarray(offset, Math.min(offset + 65515, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// packfile write and read
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in a stable oid order. */
export function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base a thin pack leaves out. Every object's SHA-1 is recomputed
 * against its declared size, so a corrupt pack is an error, never a silent bad object.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = (({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }) as Record<number, GitObjectType>)[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _resolved?: unknown })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  const result = zlibInflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

// ---------------------------------------------------------------------------------------------
// refs and advertisements
// ---------------------------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The repository's refs in advertisement order: HEAD first, then heads, then tags, sorted. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  else out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    const line: RefLine = { oid, name };
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      line.peeled = target;
    }
    out.push(line);
  }
  return out;
}

const UPLOAD_CAPS_V0 = 'side-band-64k shallow ofs-delta thin-pack multi_ack agent=git-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

/** The v0 ref advertisement: the "# service=..." preamble, then ref lines, then a flush. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: PktItem[] = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps} ${symref}\n`);
  } else {
    const head = headTip === undefined ? ZERO_OID : headTip;
    lines.push(`${head} HEAD\0${caps} ${symref}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement: "version 2", capability lines, flush. No preamble. */
export function advertiseV2(): Buffer {
  return encodePktLines(['version 2\n', 'agent=git-forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/**
 * The objects a fetch sends: what the wants reach, minus what the client already holds.
 * With a depth, only commits within that many generations of a want (plus their trees and
 * blobs) are sent, and the cut commits become the new shallow boundary. A `have` that is a
 * shallow boundary only counts for itself and its tree/blobs, never its parents.
 */
export function selectFetchObjects(repo: Repo, args: FetchArgs): { objects: Array<GitObject & { oid: string }>; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(args.shallow);
  // What the client already holds: the closure of each have, stopping at the parents of a
  // shallow boundary (its history is not held).
  const haveSet = new Set<string>();
  for (const have of args.haves) {
    const queue = [have];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      haveSet.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  // What the wants reach, within the depth when one is set. A breadth-first walk so the
  // first depth recorded for a commit is its shortest distance from a want.
  const wantSet = new Set<string>();
  const boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      commitDepth.set(want, 0);
      queue.push(want);
    } else if (object.type === 'tag') {
      wantSet.add(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        commitDepth.set(target, 0);
        queue.push(target);
      } else if (targetObject !== undefined) {
        queue.push(target);
      }
    } else {
      queue.push(want);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (wantSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    wantSet.add(oid);
    if (object.type === 'commit') {
      const depth = commitDepth.get(oid) ?? 0;
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      const withinDepth = args.depth === null || depth + 1 < args.depth;
      if (args.depth !== null && !withinDepth) boundary.add(oid);
      for (const parent of commit.parents) {
        if (withinDepth) {
          if (!commitDepth.has(parent)) commitDepth.set(parent, depth + 1);
          queue.push(parent);
        }
      }
      if (args.depth !== null && commit.parents.length === 0) boundary.add(oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  const objects: Array<GitObject & { oid: string }> = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push({ type: object.type, data: object.data, oid });
  }
  // A boundary that the client already knew as shallow, and whose parents are now all sent,
  // stops being shallow.
  const unshallow: string[] = [];
  for (const old of args.shallow) {
    if (!wantSet.has(old)) continue;
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => wantSet.has(parent))) unshallow.push(old);
  }
  return { objects, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

/** The packfile section of a v2 fetch: section name, sideband pack packets, flush. */
export function packfileSection(pack: Buffer): Buffer {
  const chunks: Buffer[] = [pktLine('packfile\n')];
  let offset = 0;
  while (offset < pack.length) {
    const slice = pack.subarray(offset, Math.min(offset + 65515, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// request handlers
// ---------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const GIT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';

function lsRefsLines(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; refPrefix: string[] }): PktItem[] {
  const lines: PktItem[] = [];
  for (const ref of listRefs(repo)) {
    if (args.refPrefix.length > 0 && !args.refPrefix.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn && !args.unborn) continue;
    if (ref.unborn) {
      lines.push(`unborn HEAD symref-target:${ref.symrefTarget}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return lines;
}

function parseV2Args(packets: Packet[]): { command: string; args: Map<string, string[]>; haves: string[] } {
  const command = { value: '' };
  const args = new Map<string, string[]>();
  const haves: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'delim') seenDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === '') continue;
    if (!seenDelim) {
      if (line.startsWith('command=')) command.value = line.slice('command='.length);
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'want' || key === 'have') {
      (key === 'want' ? args : args).set(key, [...(args.get(key) ?? []), value]);
      if (key === 'have') haves.push(value);
    } else if (key !== undefined) {
      args.set(key, [...(args.get(key) ?? []), value]);
    }
  }
  return { command: command.value, args, haves };
}

/** POST git-upload-pack: v2 ls-refs / fetch, or the v0 want/have negotiation. */
export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): GitResponse {
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }), 'utf8') };
  }
  if (isV2) {
    const { command, args, haves } = parseV2Args(packets);
    if (command === 'ls-refs') {
      const lines = lsRefsLines(repo, {
        peel: args.has('peel'),
        symrefs: args.has('symrefs'),
        unborn: args.has('unborn'),
        refPrefix: args.get('ref-prefix') ?? [],
      });
      return { status: 200, contentType: GIT_CONTENT_TYPE, body: encodePktLines(lines) };
    }
    if (command === 'fetch') {
      const wants = args.get('want') ?? [];
      const shallow = args.get('shallow') ?? [];
      const deepen = args.get('deepen') ?? [];
      const depth = deepen.length > 0 ? Number.parseInt(deepen[0] as string, 10) : null;
      const { objects, shallow: newShallow, unshallow } = selectFetchObjects(repo, {
        wants,
        haves,
        shallow,
        depth: Number.isFinite(depth) && depth !== null && depth > 0 ? depth : null,
      });
      const parts: Buffer[] = [encodePktLines(['acknowledgments\n', 'NAK\n', 'flush'])];
      if (newShallow.length > 0 || unshallow.length > 0) {
        const lines: PktItem[] = ['shallow-info\n'];
        for (const oid of newShallow) lines.push(`shallow ${oid}\n`);
        for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
        lines.push('flush');
        parts.push(encodePktLines(lines));
      }
      parts.push(packfileSection(writePack(objects)));
      parts.push(pktFlush());
      return { status: 200, contentType: GIT_CONTENT_TYPE, body: Buffer.concat(parts) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown v2 command ${command}` }), 'utf8') };
  }
  // v0: wants in the first section, haves in the second, separated by a flush.
  const wants: string[] = [];
  const v0Haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === '') continue;
    const firstSpace = line.indexOf(' ');
    const value = firstSpace === -1 ? line : line.slice(firstSpace + 1);
    if (line.startsWith('want ')) wants.push(value.split(' ')[0] as string);
    else if (line.startsWith('have ')) v0Haves.push(value.split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallow.push(value);
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  const { objects, shallow: newShallow, unshallow } = selectFetchObjects(repo, { wants, haves: v0Haves, shallow, depth });
  const parts: Buffer[] = [];
  if (newShallow.length > 0 || unshallow.length > 0) {
    const lines: PktItem[] = [];
    for (const oid of newShallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(pktLine('NAK\n'));
  parts.push(sideband(writePack(objects)));
  parts.push(pktFlush());
  return { status: 200, contentType: GIT_CONTENT_TYPE, body: Buffer.concat(parts) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: command lines, a flush, then the raw pack; a sideband report. */
export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  // The command section ends at the first flush packet; everything after it is the pack.
  let cursor = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  while (cursor < body.length) {
    if (cursor + 4 > body.length) break;
    const head = body.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packStart = cursor + 4;
      break;
    }
    if (length === 1 || length === 2 || length === 3 || length > 65520 || cursor + length > body.length) break;
    const line = body.subarray(cursor + 4, cursor + length).toString('utf8').trimEnd();
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) {
      const cleanRef = ref.split('\0')[0] as string;
      commands.push({ oldOid, newOid, ref: cleanRef });
    }
    cursor += length;
  }
  const pack = body.subarray(packStart);
  let incoming = new Map<string, GitObject>();
  if (pack.length > 0) {
    try {
      incoming = readPack(pack, (oid) => repo.objects.get(oid));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid pack';
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
    }
  }
  // Apply the ref updates that are fast-forward, one report line per command, in order.
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    if (command.newOid === ZERO_OID) {
      // Deleting a ref: allowed when the old value matches.
      if (repo.refs.get(command.ref) === command.oldOid || command.oldOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      }
      continue;
    }
    if (!incoming.has(command.newOid) && !repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    let allowed = false;
    if (command.oldOid === ZERO_OID) {
      allowed = current === undefined;
    } else if (current === command.oldOid) {
      // Fast-forward when the new tip descends from the old one.
      const combined = new Map(repo.objects);
      for (const [oid, object] of incoming) combined.set(oid, object);
      const tempRepo: Repo = { ...repo, objects: combined };
      allowed = isAncestor(tempRepo, command.oldOid, command.newOid);
    }
    if (!allowed) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  // The report-status stream is pkt-framed inside sideband band 1, per the git protocol.
  const report = encodePktLines([...reportLines, 'flush']);
  return { status: 200, contentType: GIT_CONTENT_TYPE, body: Buffer.concat([sideband(report), pktFlush()]) };
}

/** A v0 ref advertisement for the given service, or null when the repo has no refs at all. */
export function handleAdvertise(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', isV2: boolean): GitResponse {
  if (isV2 && service === 'git-upload-pack') {
    return { status: 200, contentType: GIT_CONTENT_TYPE, body: advertiseV2() };
  }
  return { status: 200, contentType: GIT_CONTENT_TYPE, body: advertiseV0(repo, service) };
}

// A re-export for the rest layer, which answers git paths through the same router.
export type { Store };
export { putObject };
