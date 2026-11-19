// GraphQL at /api/graphql: the documents gh and github-mcp-server actually send, answered
// by a small hand-rolled parser and executor — not by matching operation names. It supports
// fields, aliases, arguments (literals, variables, enums, lists, objects), inline fragments,
// named fragments, __type/__schema introspection, and batched bodies (a JSON array of
// operations answered in order). Unknown fields are HTTP 200 with an errors array naming
// the field; an unknown repository is data.repository = null with no errors; no token is 401.
//
// The documents the suite sends (program/env/src/checks-graphql.ts):
//   ViewerLogin, RepositoryFields, Issue_fields, PullRequestAndRepositoryFields,
//   SearchType_enumValues, OpenIssues (states:[OPEN], orderBy CREATED_AT DESC), IssueByNumber,
//   IssueCreate, IssueClose, PullRequests, PullRequestFiles, PullRequestId, PullRequestCreate,
//   MergePullRequest (mergeMethod:"SQUASH"), AddComment, ViewerInvalidField, NodeRepository,
//   IssuesPage (cursor pagination, pageSize 5).

import {
  issueNodeId,
  pullNodeId,
  repoNodeId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
} from './store.ts';
import { pullFileDiff, pullMergeable, squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// values and the document parser
// ---------------------------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  children: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; children: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefaults: Map<string, GqlValue>;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefaults: new Map(), selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variableDefaults = this.parseVariableDefinitions();
        operations.push({ kind, name, variableDefaults, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${token.value} at the top level`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, GqlValue> {
    const defaults = new Map<string, GqlValue>();
    const token = this.peek();
    if (token === undefined || token.kind !== 'punct' || token.value !== '(') return defaults;
    this.next();
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      const maybeEq = this.peek();
      if (maybeEq !== undefined && maybeEq.kind === 'punct' && maybeEq.value === '=') {
        this.next();
        defaults.set(name, this.parseValue());
      }
    }
    this.expectPunct(')');
    return defaults;
  }

  /** Skip a type reference such as [String!]! without building it. */
  private skipType(): void {
    const token = this.peek();
    if (token === undefined) return;
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.next();
        const after = this.peek();
        if (after !== undefined && after.kind === 'name' && after.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inlineFragment', typeCondition, children: this.parseSelectionSet() });
        } else if (after !== undefined && after.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, children: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, GqlValue>();
    const maybeParen = this.peek();
    if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    // Directives (@skip/@include) are parsed and ignored: the suite never sends them.
    while (this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      const paren = this.peek();
      if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
        this.next();
        while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) this.parseValue();
        this.expectPunct(')');
      }
    }
    let children: SelectionNode[] = [];
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      children = this.parseSelectionSet();
    }
    return { name, alias, args, children };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

/** Resolve a parsed value against the request variables (defaults already applied). */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

export function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// the schema: the field tables the executor and __type introspection share
// ---------------------------------------------------------------------------------------------

type TypeKind = 'OBJECT' | 'SCALAR' | 'ENUM' | 'INPUT_OBJECT' | 'LIST' | 'NON_NULL';

interface TypeRef {
  kind: TypeKind;
  name?: string;
  ofType?: TypeRef;
}

const scalar = (name: string): TypeRef => ({ kind: 'SCALAR', name });
const obj = (name: string): TypeRef => ({ kind: 'OBJECT', name });
const enm = (name: string): TypeRef => ({ kind: 'ENUM', name });
const inputObj = (name: string): TypeRef => ({ kind: 'INPUT_OBJECT', name });
const nonNull = (ofType: TypeRef): TypeRef => ({ kind: 'NON_NULL', ofType });
const listOf = (ofType: TypeRef): TypeRef => ({ kind: 'LIST', ofType });

interface FieldDef {
  name: string;
  type: TypeRef;
  args?: Array<{ name: string; type: TypeRef }>;
}

const ID = scalar('ID');
const STRING = scalar('String');
const INT = scalar('Int');
const BOOLEAN = scalar('Boolean');
const DATETIME = scalar('DateTime');
const URI = scalar('URI');

const FIELDS: Record<string, FieldDef[]> = {
  Query: [
    { name: 'viewer', type: nonNull(obj('User')) },
    { name: 'repository', type: obj('Repository'), args: [{ name: 'owner', type: nonNull(STRING) }, { name: 'name', type: nonNull(STRING) }] },
    { name: 'node', type: obj('Node'), args: [{ name: 'id', type: nonNull(ID) }] },
    { name: '__type', type: obj('__Type'), args: [{ name: 'name', type: nonNull(STRING) }] },
    { name: '__schema', type: nonNull(obj('__Schema')) },
  ],
  Mutation: [
    { name: 'createIssue', type: obj('CreateIssuePayload'), args: [{ name: 'input', type: nonNull(inputObj('CreateIssueInput')) }] },
    { name: 'closeIssue', type: obj('CloseIssuePayload'), args: [{ name: 'input', type: nonNull(inputObj('CloseIssueInput')) }] },
    { name: 'createPullRequest', type: obj('CreatePullRequestPayload'), args: [{ name: 'input', type: nonNull(inputObj('CreatePullRequestInput')) }] },
    { name: 'mergePullRequest', type: obj('MergePullRequestPayload'), args: [{ name: 'input', type: nonNull(inputObj('MergePullRequestInput')) }] },
    { name: 'addComment', type: obj('AddCommentPayload'), args: [{ name: 'input', type: nonNull(inputObj('AddCommentInput')) }] },
  ],
  User: [
    { name: 'id', type: nonNull(ID) },
    { name: 'login', type: nonNull(STRING) },
    { name: 'name', type: STRING },
  ],
  Repository: [
    { name: 'id', type: nonNull(ID) },
    { name: 'databaseId', type: INT },
    { name: 'name', type: nonNull(STRING) },
    { name: 'nameWithOwner', type: nonNull(STRING) },
    { name: 'owner', type: nonNull(obj('User')) },
    { name: 'defaultBranchRef', type: obj('Ref') },
    { name: 'viewerPermission', type: enm('RepositoryPermission') },
    { name: 'hasIssuesEnabled', type: nonNull(BOOLEAN) },
    { name: 'issue', type: obj('Issue'), args: [{ name: 'number', type: nonNull(INT) }] },
    { name: 'issues', type: nonNull(obj('IssueConnection')), args: [
      { name: 'first', type: INT }, { name: 'after', type: STRING },
      { name: 'states', type: listOf(nonNull(enm('IssueState'))) },
      { name: 'orderBy', type: inputObj('IssueOrder') },
    ] },
    { name: 'pullRequest', type: obj('PullRequest'), args: [{ name: 'number', type: nonNull(INT) }] },
    { name: 'pullRequests', type: nonNull(obj('PullRequestConnection')), args: [
      { name: 'first', type: INT }, { name: 'after', type: STRING },
      { name: 'states', type: listOf(nonNull(enm('PullRequestState'))) },
      { name: 'orderBy', type: inputObj('IssueOrder') },
    ] },
    { name: 'url', type: nonNull(URI) },
    { name: 'createdAt', type: DATETIME },
    { name: 'description', type: STRING },
  ],
  Issue: [
    { name: 'id', type: nonNull(ID) },
    { name: 'number', type: nonNull(INT) },
    { name: 'title', type: nonNull(STRING) },
    { name: 'state', type: nonNull(enm('IssueState')) },
    { name: 'body', type: STRING },
    { name: 'createdAt', type: nonNull(DATETIME) },
    { name: 'updatedAt', type: nonNull(DATETIME) },
    { name: 'closedAt', type: DATETIME },
    { name: 'author', type: obj('User') },
    { name: 'url', type: nonNull(URI) },
    { name: 'repository', type: nonNull(obj('Repository')) },
    { name: 'labels', type: obj('LabelConnection'), args: [{ name: 'first', type: INT }] },
    { name: 'comments', type: obj('IssueCommentConnection'), args: [{ name: 'first', type: INT }] },
  ],
  PullRequest: [
    { name: 'id', type: nonNull(ID) },
    { name: 'number', type: nonNull(INT) },
    { name: 'title', type: nonNull(STRING) },
    { name: 'state', type: nonNull(enm('PullRequestState')) },
    { name: 'body', type: STRING },
    { name: 'headRefName', type: nonNull(STRING) },
    { name: 'baseRefName', type: nonNull(STRING) },
    { name: 'mergeable', type: nonNull(enm('MergeableState')) },
    { name: 'merged', type: nonNull(BOOLEAN) },
    { name: 'mergedAt', type: DATETIME },
    { name: 'createdAt', type: nonNull(DATETIME) },
    { name: 'updatedAt', type: nonNull(DATETIME) },
    { name: 'author', type: obj('User') },
    { name: 'url', type: nonNull(URI) },
    { name: 'repository', type: nonNull(obj('Repository')) },
    { name: 'files', type: obj('PullRequestFileConnection'), args: [{ name: 'first', type: INT }, { name: 'after', type: STRING }] },
  ],
  IssueConnection: [
    { name: 'nodes', type: listOf(obj('Issue')) },
    { name: 'edges', type: listOf(obj('IssueEdge')) },
    { name: 'pageInfo', type: nonNull(obj('PageInfo')) },
    { name: 'totalCount', type: nonNull(INT) },
  ],
  IssueEdge: [
    { name: 'node', type: obj('Issue') },
    { name: 'cursor', type: nonNull(STRING) },
  ],
  PullRequestConnection: [
    { name: 'nodes', type: listOf(obj('PullRequest')) },
    { name: 'edges', type: listOf(obj('PullRequestEdge')) },
    { name: 'pageInfo', type: nonNull(obj('PageInfo')) },
    { name: 'totalCount', type: nonNull(INT) },
  ],
  PullRequestEdge: [
    { name: 'node', type: obj('PullRequest') },
    { name: 'cursor', type: nonNull(STRING) },
  ],
  PullRequestFileConnection: [
    { name: 'nodes', type: listOf(obj('PullRequestFile')) },
    { name: 'edges', type: listOf(obj('PullRequestFileEdge')) },
    { name: 'pageInfo', type: nonNull(obj('PageInfo')) },
    { name: 'totalCount', type: nonNull(INT) },
  ],
  PullRequestFileEdge: [
    { name: 'node', type: obj('PullRequestFile') },
    { name: 'cursor', type: nonNull(STRING) },
  ],
  PullRequestFile: [
    { name: 'path', type: nonNull(STRING) },
    { name: 'additions', type: nonNull(INT) },
    { name: 'deletions', type: nonNull(INT) },
  ],
  LabelConnection: [
    { name: 'nodes', type: listOf(obj('Label')) },
    { name: 'totalCount', type: nonNull(INT) },
  ],
  Label: [
    { name: 'name', type: nonNull(STRING) },
    { name: 'color', type: STRING },
    { name: 'description', type: STRING },
  ],
  IssueCommentConnection: [
    { name: 'nodes', type: listOf(obj('IssueComment')) },
    { name: 'totalCount', type: nonNull(INT) },
  ],
  IssueComment: [
    { name: 'id', type: nonNull(ID) },
    { name: 'body', type: nonNull(STRING) },
    { name: 'createdAt', type: nonNull(DATETIME) },
    { name: 'author', type: obj('User') },
    { name: 'url', type: nonNull(URI) },
  ],
  Ref: [{ name: 'name', type: nonNull(STRING) }],
  PageInfo: [
    { name: 'hasNextPage', type: nonNull(BOOLEAN) },
    { name: 'hasPreviousPage', type: nonNull(BOOLEAN) },
    { name: 'startCursor', type: STRING },
    { name: 'endCursor', type: STRING },
  ],
  CreateIssuePayload: [
    { name: 'issue', type: obj('Issue') },
    { name: 'clientMutationId', type: STRING },
  ],
  CloseIssuePayload: [
    { name: 'issue', type: obj('Issue') },
    { name: 'clientMutationId', type: STRING },
  ],
  CreatePullRequestPayload: [
    { name: 'pullRequest', type: obj('PullRequest') },
    { name: 'clientMutationId', type: STRING },
  ],
  MergePullRequestPayload: [
    { name: 'pullRequest', type: obj('PullRequest') },
    { name: 'clientMutationId', type: STRING },
  ],
  AddCommentPayload: [
    { name: 'commentEdge', type: obj('IssueCommentEdge') },
    { name: 'subject', type: obj('Issue') },
    { name: 'clientMutationId', type: STRING },
  ],
  IssueCommentEdge: [
    { name: 'node', type: obj('IssueComment') },
    { name: 'cursor', type: nonNull(STRING) },
  ],
  __Type: [
    { name: 'name', type: STRING },
    { name: 'kind', type: nonNull(enm('__TypeKind')) },
    { name: 'description', type: STRING },
    { name: 'fields', type: listOf(obj('__Field')), args: [{ name: 'includeDeprecated', type: BOOLEAN }] },
    { name: 'enumValues', type: listOf(obj('__EnumValue')), args: [{ name: 'includeDeprecated', type: BOOLEAN }] },
    { name: 'inputFields', type: listOf(obj('__InputValue')) },
    { name: 'possibleTypes', type: listOf(obj('__Type')) },
    { name: 'interfaces', type: listOf(obj('__Type')) },
  ],
  __Field: [
    { name: 'name', type: nonNull(STRING) },
    { name: 'description', type: STRING },
    { name: 'args', type: nonNull(listOf(nonNull(obj('__InputValue')))) },
    { name: 'type', type: nonNull(obj('__Type')) },
  ],
  __InputValue: [
    { name: 'name', type: nonNull(STRING) },
    { name: 'description', type: STRING },
    { name: 'type', type: nonNull(obj('__Type')) },
    { name: 'defaultValue', type: STRING },
  ],
  __EnumValue: [
    { name: 'name', type: nonNull(STRING) },
    { name: 'description', type: STRING },
  ],
  __Schema: [
    { name: 'queryType', type: nonNull(obj('__Type')) },
    { name: 'mutationType', type: obj('__Type') },
    { name: 'subscriptionType', type: obj('__Type') },
    { name: 'types', type: nonNull(listOf(nonNull(obj('__Type')))) },
    { name: 'directives', type: nonNull(listOf(nonNull(obj('__Directive')))) },
  ],
  __Directive: [
    { name: 'name', type: nonNull(STRING) },
    { name: 'description', type: STRING },
    { name: 'locations', type: nonNull(listOf(nonNull(enm('__DirectiveLocation')))) },
    { name: 'args', type: nonNull(listOf(nonNull(obj('__InputValue')))) },
  ],
};

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  __DirectiveLocation: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
};

const INPUT_FIELDS: Record<string, FieldDef[]> = {
  IssueOrder: [
    { name: 'field', type: nonNull(enm('IssueOrderField')) },
    { name: 'direction', type: nonNull(enm('OrderDirection')) },
  ],
  CreateIssueInput: [
    { name: 'repositoryId', type: nonNull(ID) },
    { name: 'title', type: nonNull(STRING) },
    { name: 'body', type: STRING },
    { name: 'clientMutationId', type: STRING },
  ],
  CloseIssueInput: [
    { name: 'issueId', type: nonNull(ID) },
    { name: 'clientMutationId', type: STRING },
  ],
  CreatePullRequestInput: [
    { name: 'repositoryId', type: nonNull(ID) },
    { name: 'baseRefName', type: nonNull(STRING) },
    { name: 'headRefName', type: nonNull(STRING) },
    { name: 'title', type: nonNull(STRING) },
    { name: 'body', type: STRING },
    { name: 'clientMutationId', type: STRING },
  ],
  MergePullRequestInput: [
    { name: 'pullRequestId', type: nonNull(ID) },
    { name: 'mergeMethod', type: enm('PullRequestMergeMethod') },
    { name: 'clientMutationId', type: STRING },
  ],
  AddCommentInput: [
    { name: 'subjectId', type: nonNull(ID) },
    { name: 'body', type: nonNull(STRING) },
    { name: 'clientMutationId', type: STRING },
  ],
};

const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'URI']);

function typeKindOf(name: string): TypeKind {
  if (SCALARS.has(name)) return 'SCALAR';
  if (ENUMS[name] !== undefined) return 'ENUM';
  if (INPUT_FIELDS[name] !== undefined) return 'INPUT_OBJECT';
  return 'OBJECT';
}

/** Every named type the schema knows, for __schema.types. */
function allTypeNames(): string[] {
  const names = new Set<string>([...Object.keys(FIELDS), ...Object.keys(ENUMS), ...Object.keys(INPUT_FIELDS), ...SCALARS, 'Node']);
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
  baseUrl: string;
}

interface Source {
  __type: string;
  [key: string]: unknown;
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: GqlContext, exec: Executor) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {};

function def(type: string, field: string, fn: Resolver): void {
  if (RESOLVERS[type] === undefined) RESOLVERS[type] = {};
  (RESOLVERS[type] as Record<string, Resolver>)[field] = fn;
}

function userSource(login: string, id: number, name: string): Source {
  return { __type: 'User', login, id, name };
}

function viewerSource(): Source {
  return userSource(VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME);
}

function repoSource(repo: Repo): Source {
  return { __type: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __type: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const parsed = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: unknown;
  after?: unknown;
  states?: unknown;
  orderBy?: unknown;
}

function pageOf<T extends { seq: number; number: number }>(
  items: T[],
  args: PageArgs,
  states: string[] | null,
  stateOf: (item: T) => string,
): { nodes: T[]; edges: Array<{ node: T; cursor: string }>; pageInfo: Source; totalCount: number } {
  let filtered = items;
  if (states !== null) filtered = filtered.filter((item) => states.includes(stateOf(item)));
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => {
    const bySeq = (a.seq - b.seq) * direction;
    if (bySeq !== 0) return bySeq;
    return (a.number - b.number) * direction;
  });
  const afterNumber = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  let start = 0;
  if (afterNumber !== null) {
    const index = sorted.findIndex((item) => item.number === afterNumber);
    start = index < 0 ? sorted.length : index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : sorted.length;
  const page = sorted.slice(start, start + first);
  const edges = page.map((item) => ({ node: item, cursor: cursorFor(item.number) }));
  const pageInfo: Source = {
    __type: 'PageInfo',
    hasNextPage: start + page.length < sorted.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
    endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
  };
  return { nodes: page, edges, pageInfo, totalCount: filtered.length };
}

// Query
def('Query', 'viewer', () => viewerSource());
def('Query', 'repository', (_source, args, ctx) => {
  const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
  return repo === undefined ? null : repoSource(repo);
});
def('Query', 'node', (_source, args, ctx) => {
  const decoded = decodeNodeIdLocal(String(args.id ?? ''));
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
    return repo === undefined ? null : repoSource(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
    if (repo === undefined) return null;
    const number = Number.parseInt(decoded.parts[1] ?? '', 10);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueSource(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullSource(repo, pull);
  }
  if (decoded.kind === 'IssueComment') {
    const wanted = Number.parseInt(decoded.parts[0] ?? '', 10);
    for (const repo of ctx.store.repos.values()) {
      for (const [number, list] of repo.comments) {
        const found = list.find((comment) => comment.id === wanted);
        if (found !== undefined) {
          const issue = repo.issues.get(number);
          if (issue !== undefined) return { __type: 'IssueComment', repo, issue, comment: found };
        }
      }
    }
    return null;
  }
  return null;
});
def('Query', '__type', (_source, args) => {
  const name = String(args.name ?? '');
  if (FIELDS[name] === undefined && ENUMS[name] === undefined && INPUT_FIELDS[name] === undefined && !SCALARS.has(name)) return null;
  return { __type: '__Type', name };
});
def('Query', '__schema', () => ({ __type: '__Schema' }));

// User
def('User', 'id', (source) => source.id);
def('User', 'login', (source) => source.login);
def('User', 'name', (source) => source.name);

// Repository
def('Repository', 'id', (source) => repoNodeId(source.repo as Repo));
def('Repository', 'databaseId', (source) => (source.repo as Repo).id);
def('Repository', 'name', (source) => (source.repo as Repo).name);
def('Repository', 'nameWithOwner', (source) => {
  const repo = source.repo as Repo;
  return `${repo.owner}/${repo.name}`;
});
def('Repository', 'owner', (source) => {
  const repo = source.repo as Repo;
  if (repo.owner === VIEWER_LOGIN) return viewerSource();
  if (repo.owner === 'faint-meadow-org') return userSource('faint-meadow-org', 2000, 'faint-meadow-org');
  return userSource(repo.owner, 3000, repo.owner);
});
def('Repository', 'defaultBranchRef', (source) => {
  const repo = source.repo as Repo;
  return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch } : null;
});
def('Repository', 'viewerPermission', () => 'ADMIN');
def('Repository', 'hasIssuesEnabled', () => true);
def('Repository', 'issue', (source, args) => {
  const repo = source.repo as Repo;
  const issue = repo.issues.get(Number(args.number));
  return issue === undefined ? null : issueSource(repo, issue);
});
def('Repository', 'issues', (source, args) => {
  const repo = source.repo as Repo;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const page = pageOf([...repo.issues.values()], args, states, (issue) => issue.state.toUpperCase());
  return {
    __type: 'IssueConnection',
    nodes: page.nodes.map((issue) => issueSource(repo, issue)),
    edges: page.edges.map((edge) => ({ __type: 'IssueEdge', node: issueSource(repo, edge.node), cursor: edge.cursor })),
    pageInfo: page.pageInfo,
    totalCount: page.totalCount,
  };
});
def('Repository', 'pullRequest', (source, args) => {
  const repo = source.repo as Repo;
  const pull = repo.pulls.get(Number(args.number));
  return pull === undefined ? null : pullSource(repo, pull);
});
def('Repository', 'pullRequests', (source, args) => {
  const repo = source.repo as Repo;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const page = pageOf([...repo.pulls.values()], args, states, (pull) => (pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  return {
    __type: 'PullRequestConnection',
    nodes: page.nodes.map((pull) => pullSource(repo, pull)),
    edges: page.edges.map((edge) => ({ __type: 'PullRequestEdge', node: pullSource(repo, edge.node), cursor: edge.cursor })),
    pageInfo: page.pageInfo,
    totalCount: page.totalCount,
  };
});
def('Repository', 'url', (source, _args, ctx) => {
  const repo = source.repo as Repo;
  return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
});
def('Repository', 'createdAt', (source) => (source.repo as Repo).createdAt);
def('Repository', 'description', (source) => (source.repo as Repo).description);

// Issue
def('Issue', 'id', (source) => issueNodeId(source.repo as Repo, (source.issue as Issue).number));
def('Issue', 'number', (source) => (source.issue as Issue).number);
def('Issue', 'title', (source) => (source.issue as Issue).title);
def('Issue', 'state', (source) => (source.issue as Issue).state.toUpperCase());
def('Issue', 'body', (source) => (source.issue as Issue).body);
def('Issue', 'createdAt', (source) => (source.issue as Issue).createdAt);
def('Issue', 'updatedAt', (source) => (source.issue as Issue).updatedAt);
def('Issue', 'closedAt', (source) => (source.issue as Issue).closedAt);
def('Issue', 'author', () => viewerSource());
def('Issue', 'url', (source, _args, ctx) => {
  const repo = source.repo as Repo;
  return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${(source.issue as Issue).number}`;
});
def('Issue', 'repository', (source) => repoSource(source.repo as Repo));
def('Issue', 'labels', (source, args) => {
  const repo = source.repo as Repo;
  const issue = source.issue as Issue;
  const names = issue.labels;
  const first = typeof args.first === 'number' ? Math.floor(args.first) : names.length;
  return {
    __type: 'LabelConnection',
    nodes: names.slice(0, first).map((name) => {
      const label = repo.labels.get(name);
      return { __type: 'Label', name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    totalCount: names.length,
  };
});
def('Issue', 'comments', (source, args) => {
  const repo = source.repo as Repo;
  const issue = source.issue as Issue;
  const list = repo.comments.get(issue.number) ?? [];
  const first = typeof args.first === 'number' ? Math.floor(args.first) : list.length;
  return {
    __type: 'IssueCommentConnection',
    nodes: list.slice(0, first).map((comment) => ({ __type: 'IssueComment', repo, issue, comment })),
    totalCount: list.length,
  };
});

// PullRequest
def('PullRequest', 'id', (source) => pullNodeId(source.repo as Repo, (source.pull as Pull).number));
def('PullRequest', 'number', (source) => (source.pull as Pull).number);
def('PullRequest', 'title', (source) => (source.pull as Pull).title);
def('PullRequest', 'state', (source) => {
  const pull = source.pull as Pull;
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
});
def('PullRequest', 'body', (source) => (source.pull as Pull).body);
def('PullRequest', 'headRefName', (source) => (source.pull as Pull).headRef);
def('PullRequest', 'baseRefName', (source) => (source.pull as Pull).baseRef);
def('PullRequest', 'mergeable', (source) => (pullMergeable(source.repo as Repo, source.pull as Pull) ? 'MERGEABLE' : 'CONFLICTING'));
def('PullRequest', 'merged', (source) => (source.pull as Pull).merged);
def('PullRequest', 'mergedAt', (source) => (source.pull as Pull).mergedAt);
def('PullRequest', 'createdAt', (source) => (source.pull as Pull).createdAt);
def('PullRequest', 'updatedAt', (source) => (source.pull as Pull).updatedAt);
def('PullRequest', 'author', () => viewerSource());
def('PullRequest', 'url', (source, _args, ctx) => {
  const repo = source.repo as Repo;
  return `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${(source.pull as Pull).number}`;
});
def('PullRequest', 'repository', (source) => repoSource(source.repo as Repo));
def('PullRequest', 'files', (source, args) => {
  const repo = source.repo as Repo;
  const pull = source.pull as Pull;
  const files = pullFileDiff(repo, pull).files;
  const first = typeof args.first === 'number' ? Math.floor(args.first) : files.length;
  const page = files.slice(0, first);
  const edges = page.map((file, index) => ({
    __type: 'PullRequestFileEdge',
    node: { __type: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions },
    cursor: cursorFor(index + 1),
  }));
  return {
    __type: 'PullRequestFileConnection',
    nodes: page.map((file) => ({ __type: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions })),
    edges,
    pageInfo: { __type: 'PageInfo', hasNextPage: first < files.length, hasPreviousPage: false, startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null, endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null },
    totalCount: files.length,
  };
});

// Connections, edges, leaf types
def('IssueConnection', 'nodes', (source) => source.nodes);
def('IssueConnection', 'edges', (source) => source.edges);
def('IssueConnection', 'pageInfo', (source) => source.pageInfo);
def('IssueConnection', 'totalCount', (source) => source.totalCount);
def('IssueEdge', 'node', (source) => source.node);
def('IssueEdge', 'cursor', (source) => source.cursor);
def('PullRequestConnection', 'nodes', (source) => source.nodes);
def('PullRequestConnection', 'edges', (source) => source.edges);
def('PullRequestConnection', 'pageInfo', (source) => source.pageInfo);
def('PullRequestConnection', 'totalCount', (source) => source.totalCount);
def('PullRequestEdge', 'node', (source) => source.node);
def('PullRequestEdge', 'cursor', (source) => source.cursor);
def('PullRequestFileConnection', 'nodes', (source) => source.nodes);
def('PullRequestFileConnection', 'edges', (source) => source.edges);
def('PullRequestFileConnection', 'pageInfo', (source) => source.pageInfo);
def('PullRequestFileConnection', 'totalCount', (source) => source.totalCount);
def('PullRequestFileEdge', 'node', (source) => source.node);
def('PullRequestFileEdge', 'cursor', (source) => source.cursor);
def('PullRequestFile', 'path', (source) => source.path);
def('PullRequestFile', 'additions', (source) => source.additions);
def('PullRequestFile', 'deletions', (source) => source.deletions);
def('LabelConnection', 'nodes', (source) => source.nodes);
def('LabelConnection', 'totalCount', (source) => source.totalCount);
def('Label', 'name', (source) => source.name);
def('Label', 'color', (source) => source.color);
def('Label', 'description', (source) => source.description);
def('IssueCommentConnection', 'nodes', (source) => source.nodes);
def('IssueCommentConnection', 'totalCount', (source) => source.totalCount);
def('IssueComment', 'id', (source) => {
  const comment = source.comment as { id: number };
  return Buffer.from(`IssueComment:${comment.id}`, 'utf8').toString('base64');
});
def('IssueComment', 'body', (source) => (source.comment as { body: string }).body);
def('IssueComment', 'createdAt', (source) => (source.comment as { createdAt: string }).createdAt);
def('IssueComment', 'author', () => viewerSource());
def('IssueComment', 'url', (source, _args, ctx) => {
  const repo = source.repo as Repo;
  const issue = source.issue as Issue;
  const comment = source.comment as { id: number };
  return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
});
def('Ref', 'name', (source) => source.name);
def('PageInfo', 'hasNextPage', (source) => source.hasNextPage);
def('PageInfo', 'hasPreviousPage', (source) => source.hasPreviousPage);
def('PageInfo', 'startCursor', (source) => source.startCursor);
def('PageInfo', 'endCursor', (source) => source.endCursor);
def('IssueCommentEdge', 'node', (source) => source.node);
def('IssueCommentEdge', 'cursor', (source) => source.cursor);

// Payloads
def('CreateIssuePayload', 'issue', (source) => source.issue);
def('CreateIssuePayload', 'clientMutationId', (source) => source.clientMutationId ?? null);
def('CloseIssuePayload', 'issue', (source) => source.issue);
def('CloseIssuePayload', 'clientMutationId', (source) => source.clientMutationId ?? null);
def('CreatePullRequestPayload', 'pullRequest', (source) => source.pullRequest);
def('CreatePullRequestPayload', 'clientMutationId', (source) => source.clientMutationId ?? null);
def('MergePullRequestPayload', 'pullRequest', (source) => source.pullRequest);
def('MergePullRequestPayload', 'clientMutationId', (source) => source.clientMutationId ?? null);
def('AddCommentPayload', 'commentEdge', (source) => source.commentEdge);
def('AddCommentPayload', 'subject', (source) => source.subject);
def('AddCommentPayload', 'clientMutationId', (source) => source.clientMutationId ?? null);

// Introspection sources
function typeRefSource(ref: TypeRef): Source {
  return { __type: '__Type', ref };
}

def('__Type', 'name', (source) => {
  if (source.ref !== undefined) {
    const ref = source.ref as TypeRef;
    return ref.name ?? null;
  }
  return source.name as string;
});
def('__Type', 'kind', (source) => {
  if (source.ref !== undefined) return (source.ref as TypeRef).kind;
  return typeKindOf(source.name as string);
});
def('__Type', 'description', () => null);
def('__Type', 'fields', (source) => {
  const name = source.ref !== undefined ? ((source.ref as TypeRef).name ?? '') : (source.name as string);
  const fields = FIELDS[name] ?? [];
  return fields.map((field) => ({ __type: '__Field', name: field.name, type: field.type, args: field.args ?? [] }));
});
def('__Type', 'enumValues', (source) => {
  const name = source.ref !== undefined ? ((source.ref as TypeRef).name ?? '') : (source.name as string);
  return (ENUMS[name] ?? []).map((value) => ({ __type: '__EnumValue', name: value }));
});
def('__Type', 'inputFields', (source) => {
  const name = source.ref !== undefined ? ((source.ref as TypeRef).name ?? '') : (source.name as string);
  return (INPUT_FIELDS[name] ?? []).map((field) => ({ __type: '__InputValue', name: field.name, type: field.type }));
});
def('__Type', 'possibleTypes', () => []);
def('__Type', 'interfaces', () => []);
def('__Field', 'name', (source) => source.name);
def('__Field', 'description', () => null);
def('__Field', 'args', (source) => (source.args as Array<{ name: string; type: TypeRef }>).map((arg) => ({ __type: '__InputValue', name: arg.name, type: arg.type })));
def('__Field', 'type', (source) => typeRefSource(source.type as TypeRef));
def('__InputValue', 'name', (source) => source.name);
def('__InputValue', 'description', () => null);
def('__InputValue', 'type', (source) => typeRefSource(source.type as TypeRef));
def('__InputValue', 'defaultValue', () => null);
def('__EnumValue', 'name', (source) => source.name);
def('__EnumValue', 'description', () => null);
def('__Schema', 'queryType', () => typeRefSource({ kind: 'OBJECT', name: 'Query' }));
def('__Schema', 'mutationType', () => typeRefSource({ kind: 'OBJECT', name: 'Mutation' }));
def('__Schema', 'subscriptionType', () => null);
def('__Schema', 'types', () => allTypeNames().map((name) => ({ __type: '__Type', name })));
def('__Schema', 'directives', () => []);
def('__Directive', 'name', (source) => source.name);
def('__Directive', 'description', () => null);
def('__Directive', 'locations', () => []);
def('__Directive', 'args', () => []);

function decodeNodeIdLocal(id: string): { kind: string; parts: string[] } | null {
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

function repoByDatabaseIdLocal(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function mutationError(message: string): Error {
  return new Error(message);
}

function createIssueMutation(input: Record<string, unknown>, ctx: GqlContext): Source {
  const decoded = decodeNodeIdLocal(String(input.repositoryId ?? ''));
  if (decoded === null || decoded.kind !== 'Repository') throw mutationError('repositoryId does not name a repository');
  const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
  if (repo === undefined) throw mutationError('repository not found');
  const title = String(input.title ?? '').trim();
  if (title === '') throw mutationError('title is required');
  const at = ctx.store.nowIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: ctx.store.nextGlobalId(),
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    seq: number,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  repo.issues.set(number, issue);
  repo.comments.set(number, []);
  return { __type: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function closeIssueMutation(input: Record<string, unknown>, ctx: GqlContext): Source {
  const decoded = decodeNodeIdLocal(String(input.issueId ?? ''));
  if (decoded === null || decoded.kind !== 'Issue') throw mutationError('issueId does not name an issue');
  const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
  const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
  if (repo === undefined || issue === undefined) throw mutationError('issue not found');
  issue.state = 'closed';
  issue.closedAt = ctx.store.nowIso();
  issue.updatedAt = ctx.store.nowIso();
  return { __type: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function createPullRequestMutation(input: Record<string, unknown>, ctx: GqlContext): Source {
  const decoded = decodeNodeIdLocal(String(input.repositoryId ?? ''));
  if (decoded === null || decoded.kind !== 'Repository') throw mutationError('repositoryId does not name a repository');
  const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
  if (repo === undefined) throw mutationError('repository not found');
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) throw mutationError('head or base branch does not exist');
  const title = String(input.title ?? '').trim();
  if (title === '') throw mutationError('title is required');
  const at = ctx.store.nowIso();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    id: ctx.store.nextGlobalId(),
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
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
  return { __type: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function mergePullRequestMutation(input: Record<string, unknown>, ctx: GqlContext): Source {
  const decoded = decodeNodeIdLocal(String(input.pullRequestId ?? ''));
  if (decoded === null || decoded.kind !== 'PullRequest') throw mutationError('pullRequestId does not name a pull request');
  const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
  const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] ?? '', 10));
  if (repo === undefined || pull === undefined) throw mutationError('pull request not found');
  if (pull.merged || pull.state === 'closed') throw mutationError('pull request is already merged or closed');
  if (!pullMergeable(repo, pull)) throw mutationError('pull request is not mergeable');
  const sha = squashMerge(ctx.store, repo, pull);
  if (sha === null) throw mutationError('pull request cannot be merged');
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = ctx.store.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = ctx.store.nowIso();
  return { __type: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function addCommentMutation(input: Record<string, unknown>, ctx: GqlContext): Source {
  const decoded = decodeNodeIdLocal(String(input.subjectId ?? ''));
  if (decoded === null || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) throw mutationError('subjectId does not name an issue or pull request');
  const repo = repoByDatabaseIdLocal(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
  const number = Number.parseInt(decoded.parts[1] ?? '', 10);
  const issue = repo?.issues.get(number);
  if (repo === undefined || issue === undefined) throw mutationError('subject not found');
  const body = String(input.body ?? '').trim();
  if (body === '') throw mutationError('body is required');
  const at = ctx.store.nowIso();
  const comment = { id: ctx.store.nextGlobalId(), body, createdAt: at, updatedAt: at };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  const commentSource: Source = { __type: 'IssueComment', repo, issue, comment };
  return {
    __type: 'AddCommentPayload',
    commentEdge: { __type: 'IssueCommentEdge', node: commentSource, cursor: cursorFor(number) },
    subject: issueSource(repo, issue),
    clientMutationId: (input.clientMutationId as string | undefined) ?? null,
  };
}

const MUTATIONS: Record<string, (input: Record<string, unknown>, ctx: GqlContext) => Source> = {
  createIssue: createIssueMutation,
  closeIssue: closeIssueMutation,
  createPullRequest: createPullRequestMutation,
  mergePullRequest: mergePullRequestMutation,
  addComment: addCommentMutation,
};

// ---------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------

export interface GqlError {
  message: string;
  path?: Array<string | number>;
}

export class Executor {
  readonly errors: GqlError[] = [];
  private readonly ctx: GqlContext;
  private readonly document: DocumentNode;
  private readonly variables: Record<string, unknown>;

  constructor(ctx: GqlContext, document: DocumentNode, variables: Record<string, unknown>) {
    this.ctx = ctx;
    this.document = document;
    this.variables = variables;
  }

  execute(operation: OperationNode): Record<string, unknown> | null {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const root: Source = { __type: rootType };
    const out = this.executeSelections(rootType, root, operation.selections, []);
    return out as Record<string, unknown> | null;
  }

  private executeSelections(typeName: string, source: Source, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> | null {
    if (source === null || source === undefined) return null;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        const fragment = this.document.fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
          continue;
        }
        const nested = this.executeSelections(typeName, source, fragment, path);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== 'Node') continue;
        const nested = this.executeSelections(selection.typeCondition ?? typeName, source, selection.children, path);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      const field = selection.field;
      const responseKey = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[responseKey] = typeName;
        continue;
      }
      const typeFields = RESOLVERS[typeName];
      let resolver = typeFields?.[field.name];
      if (resolver === undefined && typeName === 'Mutation' && MUTATIONS[field.name] !== undefined) {
        // Mutation fields run through the mutation table, not the field resolvers.
        const mutationFn = MUTATIONS[field.name] as (input: Record<string, unknown>, ctx: GqlContext) => Source;
        const mutationArgs = resolveArgs(field, this.variables);
        const input = (mutationArgs.input ?? {}) as Record<string, unknown>;
        try {
          const payload = mutationFn(input, this.ctx);
          out[responseKey] = this.completeValue(typeName, field, payload, [...path, responseKey]);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'mutation failed';
          this.errors.push({ message, path: [...path, responseKey] });
          out[responseKey] = null;
        }
        continue;
      }
      if (resolver === undefined) {
        this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [...path, responseKey] });
        continue;
      }
      const args = resolveArgs(field, this.variables);
      let value: unknown;
      try {
        value = resolver(source, args, this.ctx, this);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'field resolution failed';
        this.errors.push({ message, path: [...path, responseKey] });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = this.completeValue(typeName, field, value, [...path, responseKey]);
    }
    return out;
  }

  private completeValue(parentType: string, field: FieldNode, value: unknown, path: Array<string | number>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((item, index) => this.completeValue(parentType, field, item, [...path, index]));
    }
    if (typeof value === 'object' && (value as Source).__type !== undefined) {
      const source = value as Source;
      const typeName = source.__type;
      if (field.children.length === 0) return {};
      return this.executeSelections(typeName, source, field.children, path);
    }
    return value;
  }
}

// ---------------------------------------------------------------------------------------------
// the HTTP handler
// ---------------------------------------------------------------------------------------------

export interface GqlResponse {
  status: number;
  body: unknown;
}

interface GqlRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(ctx: GqlContext, body: GqlRequestBody): { status: number; result: Record<string, unknown> } {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { status: 400, result: { errors: [{ message: 'A GraphQL query string is required.' }] } };
  }
  let document: DocumentNode;
  try {
    document = parseGraphQL(body.query);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GraphQL syntax error';
    return { status: 400, result: { errors: [{ message }] } };
  }
  let variables: Record<string, unknown> = {};
  if (typeof body.variables === 'string') {
    try {
      const parsed: unknown = JSON.parse(body.variables);
      if (parsed !== null && typeof parsed === 'object') variables = parsed as Record<string, unknown>;
    } catch {
      return { status: 400, result: { errors: [{ message: 'variables is not valid JSON.' }] } };
    }
  } else if (body.variables !== null && typeof body.variables === 'object') {
    variables = body.variables as Record<string, unknown>;
  }
  // Variable defaults from the operation definition fill in what the request left out.
  let operation: OperationNode | undefined;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    operation = document.operations.find((op) => op.name === body.operationName);
    if (operation === undefined) {
      return { status: 400, result: { errors: [{ message: `Unknown operation named "${body.operationName}".` }] } };
    }
  } else {
    operation = document.operations[0];
  }
  if (operation === undefined) {
    return { status: 400, result: { errors: [{ message: 'The document contains no operation.' }] } };
  }
  for (const [name, fallback] of operation.variableDefaults) {
    if (variables[name] === undefined) variables[name] = resolveValue(fallback, variables);
  }
  const executor = new Executor(ctx, document, variables);
  const data = executor.execute(operation);
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return { status: 200, result };
}

/** POST /api/graphql: one operation, or a JSON array of operations answered in order. */
export function handleGraphQL(ctx: GqlContext, rawBody: Buffer | null): GqlResponse {
  let parsed: unknown;
  try {
    parsed = rawBody === null || rawBody.length === 0 ? null : JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON.' }] } };
  }
  if (Array.isArray(parsed)) {
    const results: Array<Record<string, unknown>> = [];
    let status = 200;
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        results.push({ errors: [{ message: 'Each batched operation must be an object.' }] });
        status = 400;
        continue;
      }
      const run = runOne(ctx, item as GqlRequestBody);
      if (run.status !== 200) status = run.status;
      results.push(run.result);
    }
    return { status, body: results };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { errors: [{ message: 'Request body must be a JSON object.' }] } };
  }
  const run = runOne(ctx, parsed as GqlRequestBody);
  return { status: run.status, body: run.result };
}
