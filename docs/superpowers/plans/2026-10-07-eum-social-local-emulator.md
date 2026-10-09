# EUM Social Local Emulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local emulator for AWS End User Messaging Social (WhatsApp) that unmodified AWS SDKs talk to via `endpointOverride`, with realistic async delivery events on SNS and a browser inbox.

**Architecture:** One Node 24+ TypeScript process (run directly via Node type stripping, no build step for the server). A generic Smithy layer loads AWS's official model to route, bind, validate and serialize every `restJson1` operation; hand-written handlers implement 22 operations over SQLite (`node:sqlite`); a simulator schedules Meta-style status changes on an injectable clock; an event bus wraps them in the EUM envelope and publishes to SNS (LocalStack). An admin REST API + SSE feeds a Preact inbox served from the same port.

**Tech Stack:** Node ≥ 24, TypeScript (type-check only), Fastify 5, `node:sqlite`, `yaml`, `@aws-sdk/client-sns`, `@aws-sdk/client-s3`, `@fastify/static`; tests: vitest, `@aws-sdk/client-socialmessaging`, `@aws-sdk/client-sqs`; UI: Preact + Vite.

**Spec:** `docs/specs/2026-10-07-eum-social-local-emulator-design.md`

## Global Constraints

- Node `>=24`; the server runs as `node src/main.ts` (type stripping). Therefore: **erasable TypeScript only** — no `enum`, no `namespace`, no constructor parameter properties; every relative import ends in `.ts`/`.tsx`; type-only imports use `import type`.
- Default port **4580**; AWS API under `/v1/...`, admin under `/_eum/api/...`, UI at `/_eum/ui/`, health at `/_eum/health`.
- Defaults: region `ap-south-1`, account `000000000000`, DB `./data/eum-local.db` (`EUM_DB=:memory:` for tests).
- Model file: `models/socialmessaging-2024-01-01.json`, provenance in `models/SOURCE`.
- AWS errors: HTTP status from the model's `@httpError`, header `x-amzn-ErrorType: <Name>`, body `{"message": "..."}`, plus `x-amzn-RequestId` on every `/v1` response. A handler may only throw error types declared on its operation (or the service-level `AccessDeniedException`, `ValidationException`).
- Not-simulated operations: HTTP **501**, `InternalServiceException`, message `eum-social-local-emulator: <OperationName> is not simulated yet`.
- AWS ids derive from Meta ids: `waba-` / `phone-number-id-` + first 32 hex chars of SHA-256 of `waba:<metaId>` / `phone:<metaId>`.
- Event envelope fields exactly: `context.MetaWabaIds[{wabaId, arn}]`, `context.MetaPhoneNumberIds[{metaPhoneNumberId, arn}]`, `whatsAppWebhookEntry` (JSON **string**), `aws_account_id`, `message_timestamp` (ISO with 9 fractional digits), `messageId`.
- Meta error codes used: 131026, 131047, 131049, 131050, 132000, 132001.
- Sink failures never fail the API call that caused them.

## Review Focus

1. **Phone-number id given as an ARN** (`arn:aws:social-messaging:…:phone-number-id/<hex>`) — send must work exactly as with the bare id. Test in Task 11.
2. **Reset or disassociate while deliveries are still scheduled** — no crash, no further events for removed messages. Tests in Task 9 (disassociate) and Task 13 (reset).
3. **SNS destination unreachable / sink throws** — `SendWhatsAppMessage` still returns 200; the event row records `ok: false` with the error. Test in Task 5.
4. **Malformed request body** (not JSON) or **query value of the wrong type** (`maxResults=abc`) — `ValidationException` 400, never a 500. Test in Task 8.
5. **Restart with a file database** — seeding is idempotent; the same WABA/phone ids come back. Test in Task 4.

---

### Task 1: Project scaffold and Smithy model loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.e2e.config.ts`, `.gitignore`, `src/smithy/model.ts`, `scripts/update-models.ts`
- Test: `test/smithy/model.test.ts`

**Interfaces:**
- Produces:
  - `type Traits = Record<string, any>`
  - `interface MemberRef { target: string; traits?: Traits }`
  - `interface Shape { type: string; traits?: Traits; members?: Record<string, MemberRef>; member?: MemberRef; key?: MemberRef; value?: MemberRef; input?: { target: string }; output?: { target: string }; errors?: { target: string }[] }`
  - `interface Operation { name: string; method: string; uri: string; input: string; output: string; errors: string[] }`
  - `class SmithyModel { static load(path: string): SmithyModel; readonly namespace: string; readonly operations: Map<string, Operation>; shape(id: string): Shape; errorStatus(name: string): number }`
  - `function shortName(id: string): string`
  - `const MODEL_PATH: string` (absolute path of the vendored model)

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "eum-social-local-emulator",
  "version": "0.1.0",
  "private": true,
  "description": "Local emulator for AWS End User Messaging Social (WhatsApp)",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/main.ts",
    "dev": "node --watch src/main.ts",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "typecheck": "tsc --noEmit",
    "models:update": "node scripts/update-models.ts",
    "ui:build": "vite build ui",
    "ui:dev": "vite ui"
  }
}
```

Then install dependencies:
```bash
npm i fastify @fastify/static yaml @aws-sdk/client-sns @aws-sdk/client-s3
npm i -D typescript vitest @types/node @aws-sdk/client-socialmessaging @aws-sdk/client-sqs vite preact @preact/preset-vite
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024", "dom", "dom.iterable"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  },
  "include": ["src", "test", "scripts", "ui/src", "ui/vite.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'node_modules/**'] },
})
```

`vitest.e2e.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
})
```

`.gitignore`:
```
node_modules/
data/
ui/dist/
test/java/target/
```

- [ ] **Step 2: Write the failing test**

`test/smithy/model.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel, shortName } from '../../src/smithy/model.ts'

describe('SmithyModel', () => {
  const model = SmithyModel.load(MODEL_PATH)

  it('loads every operation of the vendored model', () => {
    expect(model.operations.size).toBe(38)
    expect(model.namespace).toBe('com.amazonaws.socialmessaging')
  })

  it('reads http bindings and merges service-level errors', () => {
    const op = model.operations.get('SendWhatsAppMessage')!
    expect(op).toMatchObject({ method: 'POST', uri: '/v1/whatsapp/send' })
    expect(op.input).toBe('com.amazonaws.socialmessaging#SendWhatsAppMessageInput')
    expect(op.errors).toEqual(expect.arrayContaining(['ResourceNotFoundException', 'AccessDeniedException', 'ValidationException']))
  })

  it('resolves prelude shapes and error status codes', () => {
    expect(model.shape('smithy.api#String').type).toBe('string')
    expect(model.shape('smithy.api#Unit').type).toBe('structure')
    expect(model.errorStatus('ThrottledRequestException')).toBe(429)
    expect(model.errorStatus('ResourceNotFoundException')).toBe(404)
    expect(model.errorStatus('DependencyException')).toBe(502)
    expect(() => model.shape('nope#Nope')).toThrow(/unknown shape/)
  })

  it('shortName strips the namespace', () => {
    expect(shortName('com.amazonaws.socialmessaging#Foo')).toBe('Foo')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/smithy/model.test.ts`
Expected: FAIL — cannot resolve `../../src/smithy/model.ts`.

- [ ] **Step 4: Implement the model loader**

`src/smithy/model.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type Traits = Record<string, any>

export interface MemberRef {
  target: string
  traits?: Traits
}

export interface Shape {
  type: string
  traits?: Traits
  members?: Record<string, MemberRef>
  member?: MemberRef
  key?: MemberRef
  value?: MemberRef
  input?: { target: string }
  output?: { target: string }
  errors?: { target: string }[]
}

export interface Operation {
  name: string
  method: string
  uri: string
  input: string
  output: string
  errors: string[]
}

export const MODEL_PATH = fileURLToPath(new URL('../../models/socialmessaging-2024-01-01.json', import.meta.url))

// Shapes from the Smithy prelude are referenced but never defined in service models.
const PRELUDE: Record<string, Shape> = {
  'smithy.api#String': { type: 'string' },
  'smithy.api#Boolean': { type: 'boolean' },
  'smithy.api#PrimitiveBoolean': { type: 'boolean' },
  'smithy.api#Integer': { type: 'integer' },
  'smithy.api#PrimitiveInteger': { type: 'integer' },
  'smithy.api#Long': { type: 'long' },
  'smithy.api#PrimitiveLong': { type: 'long' },
  'smithy.api#Float': { type: 'float' },
  'smithy.api#Double': { type: 'double' },
  'smithy.api#Timestamp': { type: 'timestamp' },
  'smithy.api#Blob': { type: 'blob' },
  'smithy.api#Document': { type: 'document' },
  'smithy.api#Unit': { type: 'structure', members: {} },
}

export const shortName = (id: string): string => id.slice(id.indexOf('#') + 1)

export class SmithyModel {
  readonly shapes: Record<string, Shape>
  readonly namespace: string
  readonly operations: Map<string, Operation>

  constructor(json: { shapes: Record<string, Shape> }) {
    this.shapes = json.shapes
    const service = Object.entries(this.shapes).find(([, s]) => s.type === 'service')
    if (!service) throw new Error('eum-social-local-emulator: model has no service shape')
    this.namespace = service[0].slice(0, service[0].indexOf('#'))
    const serviceErrors = (service[1].errors ?? []).map((e) => shortName(e.target))
    this.operations = new Map()
    for (const [id, s] of Object.entries(this.shapes)) {
      const http = s.traits?.['smithy.api#http']
      if (s.type !== 'operation' || !http) continue
      this.operations.set(shortName(id), {
        name: shortName(id),
        method: String(http.method).toUpperCase(),
        uri: String(http.uri),
        input: s.input?.target ?? 'smithy.api#Unit',
        output: s.output?.target ?? 'smithy.api#Unit',
        errors: [...(s.errors ?? []).map((e) => shortName(e.target)), ...serviceErrors],
      })
    }
  }

  static load(path: string): SmithyModel {
    return new SmithyModel(JSON.parse(readFileSync(path, 'utf8')))
  }

  shape(id: string): Shape {
    const s = this.shapes[id] ?? PRELUDE[id]
    if (!s) throw new Error(`eum-social-local-emulator: unknown shape ${id}`)
    return s
  }

  errorStatus(name: string): number {
    const s = this.shapes[`${this.namespace}#${name}`]
    const status = s?.traits?.['smithy.api#httpError']
    if (typeof status === 'number') return status
    return s?.traits?.['smithy.api#error'] === 'server' ? 500 : 400
  }
}
```

- [ ] **Step 5: Add the model update script**

`scripts/update-models.ts`:
```ts
// Refreshes the vendored AWS model from github.com/aws/api-models-aws and records provenance.
import { writeFileSync } from 'node:fs'

const REPO = 'aws/api-models-aws'
const PATH = 'models/socialmessaging/service/2024-01-01/socialmessaging-2024-01-01.json'

const commitsRes = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(PATH)}&per_page=1`, {
  headers: { 'user-agent': 'eum-social-local-emulator' },
})
const commits = await commitsRes.json()
if (!Array.isArray(commits) || !commits[0]) {
  throw new Error(`could not read the latest commit for ${PATH}: ${JSON.stringify(commits).slice(0, 200)}`)
}
const sha: string = commits[0].sha
const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${PATH}`)
if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`)
const text = await res.text()
JSON.parse(text)
writeFileSync(new URL('../models/socialmessaging-2024-01-01.json', import.meta.url), text)
writeFileSync(
  new URL('../models/SOURCE', import.meta.url),
  `repo: https://github.com/${REPO}\npath: ${PATH}\ncommit: ${sha.slice(0, 7)}\ncommitted: ${commits[0].commit.committer.date}\nfetched: ${new Date().toISOString().slice(0, 10)}\n`,
)
console.log(`models updated to ${REPO}@${sha.slice(0, 7)}`)
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run test/smithy/model.test.ts && npx tsc --noEmit`
Expected: 4 tests PASS; tsc prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vitest.e2e.config.ts .gitignore src/smithy/model.ts scripts/update-models.ts test/smithy/model.test.ts
git commit -m "feat: project scaffold and Smithy model loader"
```

---

### Task 2: Router, input binding, output serialization

**Files:**
- Create: `src/smithy/router.ts`, `src/smithy/bind.ts`
- Test: `test/smithy/router.test.ts`, `test/smithy/bind.test.ts`

**Interfaces:**
- Consumes: `SmithyModel`, `Operation`, `MODEL_PATH` (Task 1)
- Produces:
  - `interface Router { match(method: string, path: string): Operation | undefined; routes(): string[] }`
  - `function buildRouter(model: SmithyModel): Router`
  - `function bindInput(model: SmithyModel, op: Operation, query: URLSearchParams, body: unknown): Record<string, unknown>` — blobs become `Buffer`, timestamps `Date`
  - `function toJson(model: SmithyModel, shapeId: string, value: unknown): unknown` — `Uint8Array` → base64, `Date` → epoch seconds, structures keep only declared members

- [ ] **Step 1: Write the failing tests**

`test/smithy/router.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { buildRouter } from '../../src/smithy/router.ts'

describe('router', () => {
  const model = SmithyModel.load(MODEL_PATH)
  const router = buildRouter(model)

  it('routes every operation to a unique method + path', () => {
    expect(router.routes()).toHaveLength(model.operations.size)
    for (const op of model.operations.values()) {
      expect(router.match(op.method, op.uri)?.name).toBe(op.name)
    }
  })

  it('distinguishes operations sharing a path by method', () => {
    expect(router.match('GET', '/v1/whatsapp/template')?.name).toBe('GetWhatsAppMessageTemplate')
    expect(router.match('POST', '/v1/whatsapp/template')?.name).toBe('UpdateWhatsAppMessageTemplate')
    expect(router.match('DELETE', '/v1/whatsapp/template')?.name).toBe('DeleteWhatsAppMessageTemplate')
  })

  it('tolerates a trailing slash and lowercase method, rejects unknown paths', () => {
    expect(router.match('post', '/v1/whatsapp/send/')?.name).toBe('SendWhatsAppMessage')
    expect(router.match('GET', '/v1/whatsapp/nope')).toBeUndefined()
  })
})
```

`test/smithy/bind.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { bindInput, toJson } from '../../src/smithy/bind.ts'

const model = SmithyModel.load(MODEL_PATH)
const op = (name: string) => model.operations.get(name)!

describe('bindInput', () => {
  it('maps query parameters by their httpQuery name, not the member name', () => {
    const q = new URLSearchParams('id=waba-1&templateName=t&deleteAllTemplates=true')
    expect(bindInput(model, op('DeleteWhatsAppMessageTemplate'), q, {})).toEqual({
      id: 'waba-1',
      templateName: 't',
      deleteAllLanguages: true,
    })
  })

  it('coerces numeric query values and leaves bad ones for the validator', () => {
    expect(bindInput(model, op('ListLinkedWhatsAppBusinessAccounts'), new URLSearchParams('maxResults=5'), {})).toEqual({ maxResults: 5 })
    expect(bindInput(model, op('ListLinkedWhatsAppBusinessAccounts'), new URLSearchParams('maxResults=abc'), {})).toEqual({ maxResults: 'abc' })
  })

  it('decodes base64 blobs from the JSON body and ignores unknown keys', () => {
    const input = bindInput(model, op('SendWhatsAppMessage'), new URLSearchParams(), {
      originationPhoneNumberId: 'phone-number-id-1',
      message: Buffer.from('{"a":1}').toString('base64'),
      metaApiVersion: 'v20.0',
      junk: 1,
    })
    expect(Buffer.isBuffer(input.message)).toBe(true)
    expect((input.message as Buffer).toString('utf8')).toBe('{"a":1}')
    expect(input).not.toHaveProperty('junk')
  })

  it('binds nested structures and lists', () => {
    const input = bindInput(model, op('PutWhatsAppBusinessAccountEventDestinations'), new URLSearchParams(), {
      id: 'waba-1',
      eventDestinations: [{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }],
    })
    expect(input.eventDestinations).toEqual([{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }])
  })
})

describe('toJson', () => {
  it('serializes timestamps as epoch seconds and drops undeclared members', () => {
    const out = toJson(model, op('ListLinkedWhatsAppBusinessAccounts').output, {
      linkedAccounts: [{ id: 'waba-1', linkDate: new Date(1_759_800_000_000), extra: 'x' }],
      ignored: true,
    })
    expect(out).toEqual({ linkedAccounts: [{ id: 'waba-1', linkDate: 1_759_800_000 }] })
  })

  it('serializes blobs as base64', () => {
    const shape = 'com.amazonaws.socialmessaging#SendWhatsAppMessageInput'
    expect(toJson(model, shape, { message: Buffer.from('hi') })).toEqual({ message: 'aGk=' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/smithy`
Expected: FAIL — cannot resolve `router.ts` / `bind.ts`.

- [ ] **Step 3: Implement the router**

`src/smithy/router.ts`:
```ts
import type { Operation, SmithyModel } from './model.ts'

export interface Router {
  match(method: string, path: string): Operation | undefined
  routes(): string[]
}

export function buildRouter(model: SmithyModel): Router {
  const table = new Map<string, Operation>()
  for (const op of model.operations.values()) {
    if (op.uri.includes('{')) {
      throw new Error(`eum-social-local-emulator: ${op.name} uses an HTTP label (${op.uri}); label routing is not implemented`)
    }
    const key = `${op.method} ${op.uri.split('?')[0]}`
    const existing = table.get(key)
    if (existing) throw new Error(`eum-social-local-emulator: ambiguous route ${key} (${existing.name}, ${op.name})`)
    table.set(key, op)
  }
  return {
    match: (method, path) => table.get(`${method.toUpperCase()} ${path.replace(/\/+$/, '') || '/'}`),
    routes: () => [...table.keys()],
  }
}
```

- [ ] **Step 4: Implement binding and serialization**

`src/smithy/bind.ts`:
```ts
import type { Operation, SmithyModel } from './model.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function bindInput(model: SmithyModel, op: Operation, query: URLSearchParams, body: unknown): Record<string, unknown> {
  const shape = model.shape(op.input)
  const fromBody = isObj(body) ? body : {}
  const input: Record<string, unknown> = {}
  for (const [name, m] of Object.entries(shape.members ?? {})) {
    const queryName = m.traits?.['smithy.api#httpQuery'] as string | undefined
    if (queryName !== undefined) {
      const v = fromQuery(model, m.target, query.getAll(queryName))
      if (v !== undefined) input[name] = v
    } else if (fromBody[name] !== undefined && fromBody[name] !== null) {
      input[name] = fromJson(model, m.target, fromBody[name])
    }
  }
  return input
}

function fromQuery(model: SmithyModel, target: string, raw: string[]): unknown {
  if (raw.length === 0) return undefined
  const shape = model.shape(target)
  if (shape.type === 'list') return raw.map((r) => scalar(model, shape.member!.target, r))
  return scalar(model, target, raw[0])
}

function scalar(model: SmithyModel, target: string, raw: string): unknown {
  switch (model.shape(target).type) {
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw
    case 'integer':
    case 'long':
    case 'float':
    case 'double': {
      const n = Number(raw)
      return raw.trim() === '' || Number.isNaN(n) ? raw : n
    }
    case 'timestamp':
      return new Date(raw)
    default:
      return raw
  }
}

export function fromJson(model: SmithyModel, target: string, v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  const shape = model.shape(target)
  switch (shape.type) {
    case 'blob':
      return typeof v === 'string' ? Buffer.from(v, 'base64') : v
    case 'timestamp':
      return typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : v
    case 'list':
      return Array.isArray(v) ? v.map((x) => fromJson(model, shape.member!.target, x)) : v
    case 'map':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(model, shape.value!.target, x)])) : v
    case 'structure': {
      if (!isObj(v)) return v
      const out: Record<string, unknown> = {}
      for (const [name, m] of Object.entries(shape.members ?? {})) {
        const x = fromJson(model, m.target, v[name])
        if (x !== undefined) out[name] = x
      }
      return out
    }
    default:
      return v
  }
}

export function toJson(model: SmithyModel, target: string, v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  const shape = model.shape(target)
  switch (shape.type) {
    case 'blob':
      return v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v
    case 'timestamp':
      return v instanceof Date ? v.getTime() / 1000 : v
    case 'list':
      return Array.isArray(v) ? v.map((x) => toJson(model, shape.member!.target, x)) : v
    case 'map':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(model, shape.value!.target, x)])) : v
    case 'structure': {
      if (!isObj(v)) return v
      const out: Record<string, unknown> = {}
      for (const [name, m] of Object.entries(shape.members ?? {})) {
        const x = toJson(model, m.target, v[name])
        if (x !== undefined) out[name] = x
      }
      return out
    }
    default:
      return v
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/smithy && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/smithy/router.ts src/smithy/bind.ts test/smithy/router.test.ts test/smithy/bind.test.ts
git commit -m "feat: model-driven router and request/response binding"
```

---

### Task 3: Constraint validator and AWS errors

**Files:**
- Create: `src/smithy/validate.ts`, `src/smithy/errors.ts`
- Test: `test/smithy/validate.test.ts`

**Interfaces:**
- Consumes: `SmithyModel` (Task 1), `bindInput` (Task 2, in tests)
- Produces:
  - `function validate(model: SmithyModel, shapeId: string, value: unknown): string[]`
  - `function validationMessage(violations: string[]): string`
  - `class AwsError extends Error { readonly type: string; readonly status?: number; constructor(type: string, message: string, status?: number) }`
  - `function notFound(what: string): AwsError` → `ResourceNotFoundException`, message `${what} not found`
  - `function invalid(message: string): AwsError` → `InvalidParametersException`

- [ ] **Step 1: Write the failing test**

`test/smithy/validate.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { validate, validationMessage } from '../../src/smithy/validate.ts'

const model = SmithyModel.load(MODEL_PATH)
const input = (op: string) => model.operations.get(op)!.input

describe('validate', () => {
  it('accepts a valid SendWhatsAppMessage input', () => {
    expect(validate(model, input('SendWhatsAppMessage'), {
      originationPhoneNumberId: 'phone-number-id-abc',
      message: Buffer.from('{}'),
      metaApiVersion: 'v20.0',
    })).toEqual([])
  })

  it('reports missing required members with the AWS wording', () => {
    expect(validate(model, input('SendWhatsAppMessage'), { message: Buffer.from('{}'), metaApiVersion: 'v20.0' })).toEqual([
      "Value null at 'originationPhoneNumberId' failed to satisfy constraint: Member must not be null",
    ])
  })

  it('checks pattern, length and range', () => {
    const v = validate(model, input('ListLinkedWhatsAppBusinessAccounts'), { maxResults: 500 })
    expect(v[0]).toMatch(/at 'maxResults'.*less than or equal to 100/)
    expect(validate(model, input('GetLinkedWhatsAppBusinessAccount'), { id: 'not-a-waba' })[0]).toMatch(/at 'id'.*regular expression pattern/)
    expect(validate(model, input('SendWhatsAppMessage'), {
      originationPhoneNumberId: 'phone-number-id-abc', message: Buffer.alloc(0), metaApiVersion: 'v20.0',
    })[0]).toMatch(/at 'message'.*length greater than or equal to 1/)
  })

  it('reports wrong JSON types instead of crashing', () => {
    expect(validate(model, input('ListLinkedWhatsAppBusinessAccounts'), { maxResults: 'abc' })[0]).toMatch(/at 'maxResults'.*must be an integer/)
    expect(validate(model, input('PutWhatsAppBusinessAccountEventDestinations'), { id: 'waba-1', eventDestinations: 'x' })[0]).toMatch(/at 'eventDestinations'.*must be a list/)
  })

  it('validates nested list members with indexed paths', () => {
    expect(validate(model, input('PutWhatsAppBusinessAccountEventDestinations'), {
      id: 'waba-1', eventDestinations: [{}],
    })).toEqual(["Value null at 'eventDestinations.0.eventDestinationArn' failed to satisfy constraint: Member must not be null"])
  })

  it('validates map keys and values', () => {
    const long = 'x'.repeat(101)
    expect(validate(model, input('ListWhatsAppTemplateLibrary'), { id: 'waba-1', filters: { [long]: 'v' } })[0]).toMatch(/filters/)
  })

  it('formats the summary message', () => {
    expect(validationMessage(['a', 'b'])).toBe('2 validation errors detected: a; b')
    expect(validationMessage(['a'])).toBe('1 validation error detected: a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/smithy/validate.test.ts`
Expected: FAIL — cannot resolve `validate.ts`.

- [ ] **Step 3: Implement the validator**

`src/smithy/validate.ts`:
```ts
import type { MemberRef, SmithyModel, Traits } from './model.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validate(model: SmithyModel, shapeId: string, value: unknown): string[] {
  const errors: string[] = []
  const shape = model.shape(shapeId)
  const obj = isObj(value) ? value : {}
  for (const [name, ref] of Object.entries(shape.members ?? {})) checkMember(model, ref, obj[name], name, errors)
  return errors
}

export function validationMessage(violations: string[]): string {
  const n = violations.length
  return `${n} validation error${n === 1 ? '' : 's'} detected: ${violations.join('; ')}`
}

function checkMember(model: SmithyModel, ref: MemberRef, v: unknown, path: string, errors: string[]): void {
  if (v === undefined || v === null) {
    if (ref.traits?.['smithy.api#required'] !== undefined) {
      errors.push(`Value null at '${path}' failed to satisfy constraint: Member must not be null`)
    }
    return
  }
  checkValue(model, ref.target, { ...model.shape(ref.target).traits, ...ref.traits }, v, path, errors)
}

function checkValue(model: SmithyModel, target: string, traits: Traits, v: unknown, path: string, errors: string[]): void {
  const shape = model.shape(target)
  const fail = (what: string) => errors.push(`Value at '${path}' failed to satisfy constraint: ${what}`)
  const sensitive = traits['smithy.api#sensitive'] !== undefined
  const shown = (x: unknown) => (sensitive ? '' : ` '${String(x).slice(0, 200)}'`)
  const length = (n: number) => {
    const l = traits['smithy.api#length']
    if (!l) return
    if (l.min !== undefined && n < l.min) errors.push(`Value${shown(v)} at '${path}' failed to satisfy constraint: Member must have length greater than or equal to ${l.min}`)
    if (l.max !== undefined && n > l.max) errors.push(`Value${shown(v)} at '${path}' failed to satisfy constraint: Member must have length less than or equal to ${l.max}`)
  }
  const range = (n: number) => {
    const r = traits['smithy.api#range']
    if (!r) return
    if (r.min !== undefined && n < r.min) errors.push(`Value '${n}' at '${path}' failed to satisfy constraint: Member must have value greater than or equal to ${r.min}`)
    if (r.max !== undefined && n > r.max) errors.push(`Value '${n}' at '${path}' failed to satisfy constraint: Member must have value less than or equal to ${r.max}`)
  }

  switch (shape.type) {
    case 'string':
    case 'enum': {
      if (typeof v !== 'string') return void fail('Member must be a string')
      if (shape.type === 'enum') {
        const allowed = Object.values(shape.members ?? {}).map((m) => m.traits?.['smithy.api#enumValue'])
        if (!allowed.includes(v)) errors.push(`Value${shown(v)} at '${path}' failed to satisfy constraint: Member must satisfy enum value set: [${allowed.join(', ')}]`)
      }
      length([...v].length)
      const pattern = traits['smithy.api#pattern']
      if (pattern && !new RegExp(pattern).test(v)) {
        errors.push(`Value${shown(v)} at '${path}' failed to satisfy constraint: Member must satisfy regular expression pattern: ${pattern}`)
      }
      return
    }
    case 'blob':
      if (!(v instanceof Uint8Array)) return void fail('Member must be a blob')
      return length(v.byteLength)
    case 'boolean':
      if (typeof v !== 'boolean') fail('Member must be a boolean')
      return
    case 'integer':
    case 'long':
      if (typeof v !== 'number' || !Number.isInteger(v)) return void fail('Member must be an integer')
      return range(v)
    case 'float':
    case 'double':
      if (typeof v !== 'number' || Number.isNaN(v)) return void fail('Member must be a number')
      return range(v)
    case 'timestamp':
      if (!(v instanceof Date) || Number.isNaN(v.getTime())) fail('Member must be a timestamp')
      return
    case 'list': {
      if (!Array.isArray(v)) return void fail('Member must be a list')
      length(v.length)
      const m = shape.member!
      v.forEach((x, i) => {
        if (x !== null && x !== undefined) checkValue(model, m.target, { ...model.shape(m.target).traits, ...m.traits }, x, `${path}.${i}`, errors)
      })
      return
    }
    case 'map': {
      if (!isObj(v)) return void fail('Member must be a map')
      length(Object.keys(v).length)
      const k = shape.key!
      const val = shape.value!
      for (const [key, x] of Object.entries(v)) {
        checkValue(model, k.target, { ...model.shape(k.target).traits, ...k.traits }, key, `${path}.${key}`, errors)
        if (x !== null && x !== undefined) checkValue(model, val.target, { ...model.shape(val.target).traits, ...val.traits }, x, `${path}.${key}`, errors)
      }
      return
    }
    case 'structure': {
      if (!isObj(v)) return void fail('Member must be a structure')
      for (const [name, ref] of Object.entries(shape.members ?? {})) checkMember(model, ref, v[name], `${path}.${name}`, errors)
      return
    }
    default:
      return
  }
}
```

- [ ] **Step 4: Implement AWS errors**

`src/smithy/errors.ts`:
```ts
// An error a handler raises on purpose. The type must be declared on the operation in the model.
export class AwsError extends Error {
  readonly type: string
  readonly status?: number

  constructor(type: string, message: string, status?: number) {
    super(message)
    this.type = type
    this.status = status
  }
}

export const notFound = (what: string): AwsError => new AwsError('ResourceNotFoundException', `${what} not found`)
export const invalid = (message: string): AwsError => new AwsError('InvalidParametersException', message)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/smithy && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/smithy/validate.ts src/smithy/errors.ts test/smithy/validate.test.ts
git commit -m "feat: Smithy constraint validator and AWS error type"
```

---

### Task 4: Config, ids, SQLite store and seeding

**Files:**
- Create: `src/config.ts`, `src/domain/ids.ts`, `src/domain/metaErrors.ts`, `src/domain/paging.ts`, `src/store/types.ts`, `src/store/db.ts`, `src/store/wabas.ts`, `src/store/templates.ts`, `src/store/messages.ts`, `src/store/media.ts`, `src/store/tags.ts`, `src/store/events.ts`, `src/store/seed.ts`, `eum-social-local-emulator.example.yaml`
- Test: `test/config.test.ts`, `test/store/store.test.ts`

**Interfaces:**
- Consumes: `AwsError`, `invalid` (Task 3)
- Produces:
  - `config.ts`: `STATUS_NAMES`, `type StatusName = 'sent' | 'delivered' | 'read' | 'failed'`, `interface PhoneSeed { phoneNumber: string; displayName: string; metaPhoneNumberId?: string; qualityRating?: string; dataLocalizationRegion?: string }`, `interface TemplateSeed { name: string; language: string; category: string; status?: string; parameterFormat?: string; components: Record<string, unknown>[] }`, `interface WabaSeed { name: string; metaWabaId?: string; eventDestinations?: string[]; phoneNumbers?: PhoneSeed[]; templates?: TemplateSeed[] }`, `interface SimRule { match: { to?: string; type?: string; template?: string }; outcome: { status?: 'failed'; code?: number; title?: string; flow?: StatusName[] } }`, `interface Config { port: number; host: string; dbPath: string; region: string; accountId: string; aws?: { endpoint: string }; webhookUrl?: string; wabas: WabaSeed[]; templates: { autoApproveSeconds: number }; sim: { defaultFlow: StatusName[]; stepDelayMs: number; rules: SimRule[] }; messageIdMode: 'uuid' | 'wamid' }`, `parseConfig(text: string | undefined, env: Record<string, string | undefined>, source?: string): Config`, `loadConfig(env?): Config`
  - `ids.ts`: `wabaAwsId(metaId)`, `phoneAwsId(metaId)`, `wabaArn(region, account, id)`, `phoneArn(region, account, id)`, `resolveId(idOrArn, kind: 'waba' | 'phone-number-id')`, `metaNumericId()`, `newWamid()`, `msisdn(raw)` (→ `+digits` or `''`), `digits(e164)`
  - `metaErrors.ts`: `interface MetaError { code: number; title: string }`, `metaError(code: number, title?: string): MetaError`, `META_ERROR_TITLES`, `META_ERRORS_HREF`
  - `paging.ts`: `paginate<T>(items: T[], nextToken: string | undefined, maxResults?: number): { items: T[]; nextToken?: string }`
  - `types.ts`: `RegistrationStatus`, `EventDestination`, `WabaRow`, `PhoneRow`, `TemplateComponent`, `TemplateRow`, `MessageStatus`, `MessageRow`, `StatusHistoryRow`, `MediaRow`, `Tag`, `EventKind`, `Delivery`, `EventRow` (exact fields below)
  - `db.ts`: `type Db = DatabaseSync`, `openDb(path: string): Db`, `resetDb(db: Db): void`
  - repos (all take `db` first): `insertWaba, getWaba, getWabaByMeta, getWabaByToken, listWabas, updateWaba, deleteWaba, insertPhone, getPhone, listPhones, updatePhoneCallSettings`; `insertTemplate, getTemplateById, findTemplate, listTemplates(db, wabaId?), listTemplatesByName, updateTemplate, setTemplateStatus, deleteTemplate, listPendingTemplates`; `insertMessage, getMessage, updateMessageStatus, statusHistory, listMessages, lastInboundAt`; `insertMedia, getMedia, deleteMedia`; `putTags, removeTags, listTags, deleteTagsFor`; `insertEvent, setDeliveries, listEvents`
  - `seed.ts`: `createWaba(db: Db, cfg: { region: string; accountId: string }, seed: WabaSeed, now: number, status?: RegistrationStatus): WabaRow`, `seedFromConfig(db: Db, config: Config, now: number): void`

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.ts'

describe('parseConfig', () => {
  it('applies defaults when there is no file', () => {
    const c = parseConfig(undefined, {})
    expect(c).toMatchObject({
      port: 4580, host: '0.0.0.0', dbPath: './data/eum-local.db', region: 'ap-south-1', accountId: '000000000000',
      wabas: [], templates: { autoApproveSeconds: 0 }, messageIdMode: 'uuid',
      sim: { defaultFlow: ['sent', 'delivered', 'read'], stepDelayMs: 1000, rules: [] },
    })
    expect(c.aws).toBeUndefined()
  })

  it('lets environment variables override the file', () => {
    const c = parseConfig('port: 1\naws:\n  endpoint: http://a:1\n', { EUM_PORT: '9', EUM_DB: ':memory:', EUM_AWS_ENDPOINT: 'http://b:2' })
    expect(c.port).toBe(9)
    expect(c.dbPath).toBe(':memory:')
    expect(c.aws).toEqual({ endpoint: 'http://b:2' })
  })

  it('keeps unquoted numeric Meta ids as strings', () => {
    const c = parseConfig('wabas:\n  - name: A\n    metaWabaId: 100000000000001\n    phoneNumbers:\n      - phoneNumber: "+919800000001"\n        displayName: A\n        metaPhoneNumberId: 200000000000001\n', {})
    expect(c.wabas[0].metaWabaId).toBe('100000000000001')
    expect(c.wabas[0].phoneNumbers![0].metaPhoneNumberId).toBe('200000000000001')
  })

  it('rejects bad config with the source and reason', () => {
    expect(() => parseConfig('wabas:\n  - name: A\n', {}, 'x.yaml')).toThrow(/x\.yaml: wabas\[0\]\.metaWabaId/)
    expect(() => parseConfig('sim:\n  defaultFlow: [sent, bogus]\n', {})).toThrow(/sim\.defaultFlow/)
    expect(() => parseConfig('messageIdMode: nope\n', {})).toThrow(/messageIdMode/)
    expect(() => parseConfig('wabas:\n  - name: A\n    metaWabaId: "1"\n    phoneNumbers:\n      - phoneNumber: "98000"\n        displayName: A\n        metaPhoneNumberId: "2"\n', {})).toThrow(/E\.164/)
  })
})
```

`test/store/store.test.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { phoneAwsId, resolveId, wabaAwsId, wabaArn, msisdn, metaNumericId, newWamid } from '../../src/domain/ids.ts'
import { paginate } from '../../src/domain/paging.ts'
import { openDb, resetDb } from '../../src/store/db.ts'
import { insertMessage, lastInboundAt, listMessages, statusHistory, updateMessageStatus } from '../../src/store/messages.ts'
import { createWaba, seedFromConfig } from '../../src/store/seed.ts'
import { findTemplate } from '../../src/store/templates.ts'
import { deleteWaba, getPhone, getWaba, listWabas } from '../../src/store/wabas.ts'

const CONFIG = parseConfig(
  'wabas:\n  - name: Test\n    metaWabaId: "100000000000001"\n    eventDestinations: [arn:aws:sns:ap-south-1:000000000000:t]\n    phoneNumbers:\n      - phoneNumber: "+919800000001"\n        displayName: Test\n        metaPhoneNumberId: "200000000000001"\n    templates:\n      - name: hello\n        language: en\n        category: utility\n        components: [{ type: BODY, text: "Hi {{1}}" }]\n',
  {},
)

describe('ids', () => {
  it('derives stable AWS ids from Meta ids', () => {
    expect(wabaAwsId('1')).toBe(wabaAwsId('1'))
    expect(wabaAwsId('1')).toMatch(/^waba-[0-9a-f]{32}$/)
    expect(phoneAwsId('2')).toMatch(/^phone-number-id-[0-9a-f]{32}$/)
  })

  it('round-trips ids through ARNs', () => {
    const id = wabaAwsId('1')
    const arn = wabaArn('ap-south-1', '000000000000', id)
    expect(arn).toMatch(/^arn:aws:social-messaging:ap-south-1:000000000000:waba\/[0-9a-f]{32}$/)
    expect(resolveId(arn, 'waba')).toBe(id)
    expect(resolveId(id, 'waba')).toBe(id)
  })

  it('normalises phone numbers and generates Meta-shaped ids', () => {
    expect(msisdn('91 98000-00001')).toBe('+919800000001')
    expect(msisdn('abc')).toBe('')
    expect(metaNumericId()).toMatch(/^[1-9]\d{14}$/)
    expect(newWamid()).toMatch(/^wamid\.[A-Za-z0-9]+$/)
  })
})

describe('paginate', () => {
  it('pages with opaque tokens and rejects garbage tokens', () => {
    const items = [1, 2, 3, 4, 5]
    const p1 = paginate(items, undefined, 2)
    expect(p1.items).toEqual([1, 2])
    const p2 = paginate(items, p1.nextToken, 2)
    expect(p2.items).toEqual([3, 4])
    expect(paginate(items, p2.nextToken, 2)).toEqual({ items: [5], nextToken: undefined })
    expect(() => paginate(items, 'garbage', 2)).toThrow(/nextToken/)
  })
})

describe('store', () => {
  it('seeds from config with derived ids and approved templates', () => {
    const db = openDb(':memory:')
    seedFromConfig(db, CONFIG, 1000)
    const waba = getWaba(db, wabaAwsId('100000000000001'))!
    expect(waba).toMatchObject({ name: 'Test', registrationStatus: 'COMPLETE', linkDate: 1000 })
    expect(waba.eventDestinations).toEqual([{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }])
    expect(getPhone(db, phoneAwsId('200000000000001'))).toMatchObject({ phoneNumber: '+919800000001', wabaId: waba.id })
    expect(findTemplate(db, waba.id, 'hello', 'en')).toMatchObject({ status: 'APPROVED', category: 'UTILITY' })
  })

  it('is idempotent across restarts with a file database (Review Focus 5)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eum-')), 'db.sqlite')
    const db1 = openDb(path)
    seedFromConfig(db1, CONFIG, 1)
    db1.close()
    const db2 = openDb(path)
    seedFromConfig(db2, CONFIG, 2)
    expect(listWabas(db2)).toHaveLength(1)
    expect(listWabas(db2)[0].id).toBe(wabaAwsId('100000000000001'))
    db2.close()
  })

  it('tracks message status history and the last inbound time', () => {
    const db = openDb(':memory:')
    seedFromConfig(db, CONFIG, 0)
    const phoneNumberId = phoneAwsId('200000000000001')
    insertMessage(db, { wamid: 'w1', phoneNumberId, direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 10 })
    updateMessageStatus(db, 'w1', 'failed', { code: 131026, title: 'Message undeliverable' }, 20)
    expect(listMessages(db, {})[0]).toMatchObject({ status: 'failed', errorCode: 131026 })
    expect(statusHistory(db, 'w1').map((h) => h.status)).toEqual(['accepted', 'failed'])
    expect(lastInboundAt(db, phoneNumberId, '+1')).toBeUndefined()
    insertMessage(db, { wamid: 'w2', phoneNumberId, direction: 'in', peer: '+1', type: 'text', body: {}, status: 'received', createdAt: 30 })
    expect(lastInboundAt(db, phoneNumberId, '+1')).toBe(30)
  })

  it('cascades WABA deletion to phones and messages, and reset empties everything', () => {
    const db = openDb(':memory:')
    const waba = createWaba(db, CONFIG, CONFIG.wabas[0], 0)
    insertMessage(db, { wamid: 'w1', phoneNumberId: phoneAwsId('200000000000001'), direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 1 })
    deleteWaba(db, waba.id)
    expect(getPhone(db, phoneAwsId('200000000000001'))).toBeUndefined()
    expect(listMessages(db, {})).toEqual([])
    createWaba(db, CONFIG, CONFIG.wabas[0], 0)
    resetDb(db)
    expect(listWabas(db)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts test/store`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement config**

`src/config.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'

export const STATUS_NAMES = ['sent', 'delivered', 'read', 'failed'] as const
export type StatusName = (typeof STATUS_NAMES)[number]

export interface PhoneSeed {
  phoneNumber: string
  displayName: string
  metaPhoneNumberId?: string
  qualityRating?: string
  dataLocalizationRegion?: string
}

export interface TemplateSeed {
  name: string
  language: string
  category: string
  status?: string
  parameterFormat?: string
  components: Record<string, unknown>[]
}

export interface WabaSeed {
  name: string
  metaWabaId?: string
  eventDestinations?: string[]
  phoneNumbers?: PhoneSeed[]
  templates?: TemplateSeed[]
}

export interface SimRule {
  match: { to?: string; type?: string; template?: string }
  outcome: { status?: 'failed'; code?: number; title?: string; flow?: StatusName[] }
}

export interface Config {
  port: number
  host: string
  dbPath: string
  region: string
  accountId: string
  aws?: { endpoint: string }
  webhookUrl?: string
  wabas: WabaSeed[]
  templates: { autoApproveSeconds: number }
  sim: { defaultFlow: StatusName[]; stepDelayMs: number; rules: SimRule[] }
  messageIdMode: 'uuid' | 'wamid'
}

export function parseConfig(text: string | undefined, env: Record<string, string | undefined>, source = '(defaults)'): Config {
  const fail = (msg: string): never => {
    throw new Error(`eum-social-local-emulator config ${source}: ${msg}`)
  }
  const raw: any = text ? (parse(text) ?? {}) : {}
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be a mapping')

  const flow = (f: unknown, where: string): StatusName[] => {
    if (!Array.isArray(f) || f.length === 0 || !f.every((s) => (STATUS_NAMES as readonly string[]).includes(s))) {
      fail(`${where} must be a non-empty list of ${STATUS_NAMES.join('|')}`)
    }
    return f as StatusName[]
  }

  const sim = raw.sim ?? {}
  const rules: SimRule[] = (sim.rules ?? []).map((r: any, i: number) => {
    if (!r?.match || !r?.outcome) fail(`sim.rules[${i}] needs match and outcome`)
    if (r.outcome.flow) flow(r.outcome.flow, `sim.rules[${i}].outcome.flow`)
    if (r.outcome.status !== undefined && r.outcome.status !== 'failed') fail(`sim.rules[${i}].outcome.status can only be failed`)
    return r as SimRule
  })

  const wabas: WabaSeed[] = (raw.wabas ?? []).map((w: any, i: number) => {
    if (!w?.name) fail(`wabas[${i}].name is required`)
    if (!/^\d+$/.test(String(w.metaWabaId ?? ''))) fail(`wabas[${i}].metaWabaId is required (digits) so ids stay stable across restarts`)
    const phoneNumbers = (w.phoneNumbers ?? []).map((p: any, j: number) => {
      const at = `wabas[${i}].phoneNumbers[${j}]`
      if (!/^\+\d{8,15}$/.test(String(p?.phoneNumber ?? ''))) fail(`${at}.phoneNumber must be E.164, e.g. +919800000001`)
      if (!p.displayName) fail(`${at}.displayName is required`)
      if (!/^\d+$/.test(String(p.metaPhoneNumberId ?? ''))) fail(`${at}.metaPhoneNumberId is required (digits)`)
      return { ...p, metaPhoneNumberId: String(p.metaPhoneNumberId) }
    })
    for (const [j, t] of (w.templates ?? []).entries()) {
      if (!t?.name || !t.language || !t.category || !Array.isArray(t.components)) {
        fail(`wabas[${i}].templates[${j}] needs name, language, category and components`)
      }
    }
    return { ...w, metaWabaId: String(w.metaWabaId), phoneNumbers }
  })

  const messageIdMode = raw.messageIdMode ?? 'uuid'
  if (messageIdMode !== 'uuid' && messageIdMode !== 'wamid') fail('messageIdMode must be uuid or wamid')
  const awsEndpoint = env.EUM_AWS_ENDPOINT ?? raw.aws?.endpoint

  return {
    port: Number(env.EUM_PORT ?? raw.port ?? 4580),
    host: env.EUM_HOST ?? raw.host ?? '0.0.0.0',
    dbPath: env.EUM_DB ?? raw.dbPath ?? './data/eum-local.db',
    region: env.EUM_REGION ?? raw.region ?? 'ap-south-1',
    accountId: String(raw.accountId ?? '000000000000'),
    aws: awsEndpoint ? { endpoint: awsEndpoint } : undefined,
    webhookUrl: raw.webhookUrl,
    wabas,
    templates: { autoApproveSeconds: Number(raw.templates?.autoApproveSeconds ?? 0) },
    sim: { defaultFlow: flow(sim.defaultFlow ?? ['sent', 'delivered', 'read'], 'sim.defaultFlow'), stepDelayMs: Number(sim.stepDelayMs ?? 1000), rules },
    messageIdMode,
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (env.EUM_CONFIG && !existsSync(env.EUM_CONFIG)) throw new Error(`eum-social-local-emulator config ${env.EUM_CONFIG}: file not found`)
  const path = env.EUM_CONFIG ?? (existsSync('eum-social-local-emulator.yaml') ? 'eum-social-local-emulator.yaml' : undefined)
  return parseConfig(path ? readFileSync(path, 'utf8') : undefined, env, path)
}
```

- [ ] **Step 4: Implement ids, Meta errors, paging**

`src/domain/ids.ts`:
```ts
import { createHash, randomBytes, randomInt } from 'node:crypto'

const hex32 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

// AWS ids derive from Meta ids so they survive restarts and resets.
export const wabaAwsId = (metaWabaId: string) => `waba-${hex32(`waba:${metaWabaId}`)}`
export const phoneAwsId = (metaPhoneNumberId: string) => `phone-number-id-${hex32(`phone:${metaPhoneNumberId}`)}`

export const wabaArn = (region: string, accountId: string, id: string) =>
  `arn:aws:social-messaging:${region}:${accountId}:waba/${id.slice('waba-'.length)}`
export const phoneArn = (region: string, accountId: string, id: string) =>
  `arn:aws:social-messaging:${region}:${accountId}:phone-number-id/${id.slice('phone-number-id-'.length)}`

export function resolveId(idOrArn: string, kind: 'waba' | 'phone-number-id'): string {
  if (!idOrArn.startsWith('arn:')) return idOrArn
  return `${kind}-${idOrArn.slice(idOrArn.lastIndexOf('/') + 1)}`
}

export const metaNumericId = () => `${randomInt(1, 10)}${String(randomInt(0, 1e14)).padStart(14, '0')}`
export const newWamid = () => `wamid.${randomBytes(30).toString('base64').replace(/[+/=]/g, '')}`

export function msisdn(raw: string): string {
  const d = raw.replace(/\D/g, '')
  return d ? `+${d}` : ''
}

export const digits = (e164: string) => e164.replace(/\D/g, '')
```

`src/domain/metaErrors.ts`:
```ts
export interface MetaError {
  code: number
  title: string
}

export const META_ERRORS_HREF = 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/'

export const META_ERROR_TITLES: Record<number, string> = {
  131000: 'Something went wrong',
  131026: 'Message undeliverable',
  131047: 'Re-engagement message',
  131049: 'This message was not delivered to maintain healthy ecosystem engagement.',
  131050: 'Unable to deliver the message. This recipient has chosen to stop receiving marketing messages on WhatsApp from your business.',
  132000: 'Number of parameters does not match the expected number of params',
  132001: 'Template name does not exist in the translation',
}

export const metaError = (code: number, title?: string): MetaError => ({
  code,
  title: title ?? META_ERROR_TITLES[code] ?? 'Unknown error',
})
```

`src/domain/paging.ts`:
```ts
import { invalid } from '../smithy/errors.ts'

export function paginate<T>(items: T[], nextToken: string | undefined, maxResults = 100): { items: T[]; nextToken?: string } {
  let offset = 0
  if (nextToken) {
    try {
      offset = JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8')).o
    } catch {
      offset = Number.NaN
    }
    if (!Number.isInteger(offset) || offset < 0) throw invalid('nextToken is invalid')
  }
  const end = offset + maxResults
  return {
    items: items.slice(offset, end),
    nextToken: end < items.length ? Buffer.from(JSON.stringify({ o: end })).toString('base64url') : undefined,
  }
}
```

- [ ] **Step 5: Implement store types and database**

`src/store/types.ts`:
```ts
import type { StatusName } from '../config.ts'
import type { Envelope } from '../events/envelope.ts'

export type RegistrationStatus = 'COMPLETE' | 'INCOMPLETE'

export interface EventDestination {
  eventDestinationArn: string
  roleArn?: string
}

export interface WabaRow {
  id: string
  arn: string
  metaWabaId: string
  name: string
  registrationStatus: RegistrationStatus
  linkDate: number
  eventDestinations: EventDestination[]
  associateToken?: string
}

export interface PhoneRow {
  id: string
  arn: string
  wabaId: string
  metaPhoneNumberId: string
  phoneNumber: string
  displayPhoneNumber: string
  displayName: string
  qualityRating: string
  dataLocalizationRegion?: string
  callSettings?: unknown
}

export interface TemplateComponent {
  type: string
  text?: string
  format?: string
  [key: string]: unknown
}

export interface TemplateRow {
  metaTemplateId: string
  wabaId: string
  name: string
  language: string
  category: string
  status: string
  parameterFormat: string
  components: TemplateComponent[]
  createdAt: number
  updatedAt: number
}

export type MessageStatus = 'accepted' | 'received' | StatusName

export interface MessageRow {
  wamid: string
  awsMessageId?: string
  phoneNumberId: string
  direction: 'out' | 'in'
  peer: string
  type: string
  body: any
  renderedText?: string
  category?: string
  status: MessageStatus
  errorCode?: number
  errorTitle?: string
  createdAt: number
}

export interface StatusHistoryRow {
  status: string
  errorCode?: number
  at: number
}

export interface MediaRow {
  mediaId: string
  ownerId: string
  mimeType: string
  sha256: string
  bytes: Uint8Array
  createdAt: number
}

export interface Tag {
  key: string
  value?: string
}

export type EventKind = 'status' | 'inbound' | 'template_status'

export interface Delivery {
  destination: string
  ok: boolean
  detail: string
}

export interface EventRow {
  id: string
  kind: EventKind
  wabaId?: string
  wamid?: string
  envelope: Envelope
  deliveries: Delivery[]
  at: number
}
```

`src/store/db.ts`:
```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS waba (
  id TEXT PRIMARY KEY,
  arn TEXT NOT NULL UNIQUE,
  meta_waba_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  registration_status TEXT NOT NULL,
  link_date INTEGER NOT NULL,
  event_destinations TEXT NOT NULL DEFAULT '[]',
  associate_token TEXT
);
CREATE TABLE IF NOT EXISTS phone_number (
  id TEXT PRIMARY KEY,
  arn TEXT NOT NULL UNIQUE,
  waba_id TEXT NOT NULL REFERENCES waba(id) ON DELETE CASCADE,
  meta_phone_number_id TEXT NOT NULL UNIQUE,
  phone_number TEXT NOT NULL,
  display_phone_number TEXT NOT NULL,
  display_name TEXT NOT NULL,
  quality_rating TEXT NOT NULL DEFAULT 'GREEN',
  data_localization_region TEXT,
  call_settings TEXT
);
CREATE TABLE IF NOT EXISTS template (
  meta_template_id TEXT PRIMARY KEY,
  waba_id TEXT NOT NULL REFERENCES waba(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  parameter_format TEXT NOT NULL DEFAULT 'POSITIONAL',
  components TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (waba_id, name, language)
);
CREATE TABLE IF NOT EXISTS message (
  wamid TEXT PRIMARY KEY,
  aws_message_id TEXT UNIQUE,
  phone_number_id TEXT NOT NULL REFERENCES phone_number(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  peer TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  rendered_text TEXT,
  category TEXT,
  status TEXT NOT NULL,
  error_code INTEGER,
  error_title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_thread ON message (phone_number_id, peer, created_at);
CREATE TABLE IF NOT EXISTS message_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wamid TEXT NOT NULL REFERENCES message(wamid) ON DELETE CASCADE,
  status TEXT NOT NULL,
  error_code INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  media_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag (
  resource_arn TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (resource_arn, key)
);
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  waba_id TEXT,
  wamid TEXT,
  envelope TEXT NOT NULL,
  deliveries TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL
);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

export function resetDb(db: Db): void {
  db.exec('DELETE FROM event; DELETE FROM tag; DELETE FROM media; DELETE FROM message_status; DELETE FROM message; DELETE FROM template; DELETE FROM phone_number; DELETE FROM waba;')
}
```

- [ ] **Step 6: Implement repositories**

`src/store/wabas.ts`:
```ts
import type { Db } from './db.ts'
import type { PhoneRow, WabaRow } from './types.ts'

type Row = Record<string, any>

const toWaba = (r: Row): WabaRow => ({
  id: r.id,
  arn: r.arn,
  metaWabaId: r.meta_waba_id,
  name: r.name,
  registrationStatus: r.registration_status,
  linkDate: r.link_date,
  eventDestinations: JSON.parse(r.event_destinations),
  associateToken: r.associate_token ?? undefined,
})

const toPhone = (r: Row): PhoneRow => ({
  id: r.id,
  arn: r.arn,
  wabaId: r.waba_id,
  metaPhoneNumberId: r.meta_phone_number_id,
  phoneNumber: r.phone_number,
  displayPhoneNumber: r.display_phone_number,
  displayName: r.display_name,
  qualityRating: r.quality_rating,
  dataLocalizationRegion: r.data_localization_region ?? undefined,
  callSettings: r.call_settings ? JSON.parse(r.call_settings) : undefined,
})

export function insertWaba(db: Db, w: WabaRow): void {
  db.prepare(
    'INSERT INTO waba (id, arn, meta_waba_id, name, registration_status, link_date, event_destinations, associate_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(w.id, w.arn, w.metaWabaId, w.name, w.registrationStatus, w.linkDate, JSON.stringify(w.eventDestinations), w.associateToken ?? null)
}

export function getWaba(db: Db, id: string): WabaRow | undefined {
  const r = db.prepare('SELECT * FROM waba WHERE id = ?').get(id) as Row | undefined
  return r ? toWaba(r) : undefined
}

export function getWabaByMeta(db: Db, metaWabaId: string): WabaRow | undefined {
  const r = db.prepare('SELECT * FROM waba WHERE meta_waba_id = ?').get(metaWabaId) as Row | undefined
  return r ? toWaba(r) : undefined
}

export function getWabaByToken(db: Db, token: string): WabaRow | undefined {
  const r = db.prepare('SELECT * FROM waba WHERE associate_token = ?').get(token) as Row | undefined
  return r ? toWaba(r) : undefined
}

export function listWabas(db: Db): WabaRow[] {
  return (db.prepare('SELECT * FROM waba ORDER BY link_date, id').all() as Row[]).map(toWaba)
}

export function updateWaba(db: Db, w: WabaRow): void {
  db.prepare('UPDATE waba SET name = ?, registration_status = ?, event_destinations = ?, associate_token = ? WHERE id = ?').run(
    w.name,
    w.registrationStatus,
    JSON.stringify(w.eventDestinations),
    w.associateToken ?? null,
    w.id,
  )
}

export function deleteWaba(db: Db, id: string): void {
  db.prepare('DELETE FROM waba WHERE id = ?').run(id)
}

export function insertPhone(db: Db, p: PhoneRow): void {
  db.prepare(
    'INSERT INTO phone_number (id, arn, waba_id, meta_phone_number_id, phone_number, display_phone_number, display_name, quality_rating, data_localization_region, call_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    p.id,
    p.arn,
    p.wabaId,
    p.metaPhoneNumberId,
    p.phoneNumber,
    p.displayPhoneNumber,
    p.displayName,
    p.qualityRating,
    p.dataLocalizationRegion ?? null,
    p.callSettings === undefined ? null : JSON.stringify(p.callSettings),
  )
}

export function getPhone(db: Db, id: string): PhoneRow | undefined {
  const r = db.prepare('SELECT * FROM phone_number WHERE id = ?').get(id) as Row | undefined
  return r ? toPhone(r) : undefined
}

export function listPhones(db: Db, wabaId: string): PhoneRow[] {
  return (db.prepare('SELECT * FROM phone_number WHERE waba_id = ? ORDER BY phone_number').all(wabaId) as Row[]).map(toPhone)
}

export function updatePhoneCallSettings(db: Db, id: string, callSettings: unknown): void {
  db.prepare('UPDATE phone_number SET call_settings = ? WHERE id = ?').run(JSON.stringify(callSettings), id)
}
```

`src/store/templates.ts`:
```ts
import type { Db } from './db.ts'
import type { TemplateRow } from './types.ts'

type Row = Record<string, any>

const toTemplate = (r: Row): TemplateRow => ({
  metaTemplateId: r.meta_template_id,
  wabaId: r.waba_id,
  name: r.name,
  language: r.language,
  category: r.category,
  status: r.status,
  parameterFormat: r.parameter_format,
  components: JSON.parse(r.components),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function insertTemplate(db: Db, t: TemplateRow): void {
  db.prepare(
    'INSERT INTO template (meta_template_id, waba_id, name, language, category, status, parameter_format, components, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(t.metaTemplateId, t.wabaId, t.name, t.language, t.category, t.status, t.parameterFormat, JSON.stringify(t.components), t.createdAt, t.updatedAt)
}

export function getTemplateById(db: Db, metaTemplateId: string): TemplateRow | undefined {
  const r = db.prepare('SELECT * FROM template WHERE meta_template_id = ?').get(metaTemplateId) as Row | undefined
  return r ? toTemplate(r) : undefined
}

export function findTemplate(db: Db, wabaId: string, name: string, language: string): TemplateRow | undefined {
  const r = db.prepare('SELECT * FROM template WHERE waba_id = ? AND name = ? AND language = ?').get(wabaId, name, language) as Row | undefined
  return r ? toTemplate(r) : undefined
}

export function listTemplates(db: Db, wabaId?: string): TemplateRow[] {
  const rows = wabaId
    ? db.prepare('SELECT * FROM template WHERE waba_id = ? ORDER BY name, language').all(wabaId)
    : db.prepare('SELECT * FROM template ORDER BY waba_id, name, language').all()
  return (rows as Row[]).map(toTemplate)
}

export function listTemplatesByName(db: Db, wabaId: string, name: string): TemplateRow[] {
  return (db.prepare('SELECT * FROM template WHERE waba_id = ? AND name = ? ORDER BY language').all(wabaId, name) as Row[]).map(toTemplate)
}

export function updateTemplate(db: Db, t: TemplateRow): void {
  db.prepare('UPDATE template SET category = ?, status = ?, parameter_format = ?, components = ?, updated_at = ? WHERE meta_template_id = ?').run(
    t.category,
    t.status,
    t.parameterFormat,
    JSON.stringify(t.components),
    t.updatedAt,
    t.metaTemplateId,
  )
}

export function setTemplateStatus(db: Db, metaTemplateId: string, status: string, at: number): void {
  db.prepare('UPDATE template SET status = ?, updated_at = ? WHERE meta_template_id = ?').run(status, at, metaTemplateId)
}

export function deleteTemplate(db: Db, metaTemplateId: string): void {
  db.prepare('DELETE FROM template WHERE meta_template_id = ?').run(metaTemplateId)
}

export function listPendingTemplates(db: Db): TemplateRow[] {
  return (db.prepare("SELECT * FROM template WHERE status = 'PENDING'").all() as Row[]).map(toTemplate)
}
```

`src/store/messages.ts`:
```ts
import type { MetaError } from '../domain/metaErrors.ts'
import type { Db } from './db.ts'
import type { MessageRow, MessageStatus, StatusHistoryRow } from './types.ts'

type Row = Record<string, any>

const toMessage = (r: Row): MessageRow => ({
  wamid: r.wamid,
  awsMessageId: r.aws_message_id ?? undefined,
  phoneNumberId: r.phone_number_id,
  direction: r.direction,
  peer: r.peer,
  type: r.type,
  body: JSON.parse(r.body),
  renderedText: r.rendered_text ?? undefined,
  category: r.category ?? undefined,
  status: r.status,
  errorCode: r.error_code ?? undefined,
  errorTitle: r.error_title ?? undefined,
  createdAt: r.created_at,
})

export function insertMessage(db: Db, m: MessageRow): void {
  db.prepare(
    'INSERT INTO message (wamid, aws_message_id, phone_number_id, direction, peer, type, body, rendered_text, category, status, error_code, error_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    m.wamid,
    m.awsMessageId ?? null,
    m.phoneNumberId,
    m.direction,
    m.peer,
    m.type,
    JSON.stringify(m.body),
    m.renderedText ?? null,
    m.category ?? null,
    m.status,
    m.errorCode ?? null,
    m.errorTitle ?? null,
    m.createdAt,
  )
  db.prepare('INSERT INTO message_status (wamid, status, error_code, at) VALUES (?, ?, ?, ?)').run(m.wamid, m.status, m.errorCode ?? null, m.createdAt)
}

export function getMessage(db: Db, wamid: string): MessageRow | undefined {
  const r = db.prepare('SELECT * FROM message WHERE wamid = ?').get(wamid) as Row | undefined
  return r ? toMessage(r) : undefined
}

export function updateMessageStatus(db: Db, wamid: string, status: MessageStatus, failure: MetaError | undefined, at: number): void {
  db.prepare('UPDATE message SET status = ?, error_code = ?, error_title = ? WHERE wamid = ?').run(status, failure?.code ?? null, failure?.title ?? null, wamid)
  db.prepare('INSERT INTO message_status (wamid, status, error_code, at) VALUES (?, ?, ?, ?)').run(wamid, status, failure?.code ?? null, at)
}

export function statusHistory(db: Db, wamid: string): StatusHistoryRow[] {
  return (db.prepare('SELECT status, error_code, at FROM message_status WHERE wamid = ? ORDER BY id').all(wamid) as Row[]).map((r) => ({
    status: r.status,
    errorCode: r.error_code ?? undefined,
    at: r.at,
  }))
}

export function listMessages(db: Db, f: { phoneNumberId?: string; peer?: string; status?: string; limit?: number }): MessageRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.phoneNumberId) where.push('phone_number_id = ?'), args.push(f.phoneNumberId)
  if (f.peer) where.push('peer = ?'), args.push(f.peer)
  if (f.status) where.push('status = ?'), args.push(f.status)
  const sql = `SELECT * FROM message ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
  return (db.prepare(sql).all(...args, f.limit ?? 500) as Row[]).map(toMessage)
}

export function lastInboundAt(db: Db, phoneNumberId: string, peer: string): number | undefined {
  const r = db.prepare("SELECT max(created_at) AS at FROM message WHERE phone_number_id = ? AND peer = ? AND direction = 'in'").get(phoneNumberId, peer) as Row
  return r.at ?? undefined
}
```

`src/store/media.ts`:
```ts
import type { Db } from './db.ts'
import type { MediaRow } from './types.ts'

type Row = Record<string, any>

export function insertMedia(db: Db, m: MediaRow): void {
  db.prepare('INSERT INTO media (media_id, owner_id, mime_type, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    m.mediaId,
    m.ownerId,
    m.mimeType,
    m.sha256,
    m.bytes,
    m.createdAt,
  )
}

export function getMedia(db: Db, mediaId: string): MediaRow | undefined {
  const r = db.prepare('SELECT * FROM media WHERE media_id = ?').get(mediaId) as Row | undefined
  return r
    ? { mediaId: r.media_id, ownerId: r.owner_id, mimeType: r.mime_type, sha256: r.sha256, bytes: r.bytes, createdAt: r.created_at }
    : undefined
}

export function deleteMedia(db: Db, mediaId: string): void {
  db.prepare('DELETE FROM media WHERE media_id = ?').run(mediaId)
}
```

`src/store/tags.ts`:
```ts
import type { Db } from './db.ts'
import type { Tag } from './types.ts'

export function putTags(db: Db, arn: string, tags: Tag[]): void {
  const stmt = db.prepare('INSERT INTO tag (resource_arn, key, value) VALUES (?, ?, ?) ON CONFLICT (resource_arn, key) DO UPDATE SET value = excluded.value')
  for (const t of tags) stmt.run(arn, t.key, t.value ?? null)
}

export function removeTags(db: Db, arn: string, keys: string[]): void {
  const stmt = db.prepare('DELETE FROM tag WHERE resource_arn = ? AND key = ?')
  for (const k of keys) stmt.run(arn, k)
}

export function listTags(db: Db, arn: string): Tag[] {
  return (db.prepare('SELECT key, value FROM tag WHERE resource_arn = ? ORDER BY key').all(arn) as Record<string, any>[]).map((r) => ({
    key: r.key,
    value: r.value ?? undefined,
  }))
}

export function deleteTagsFor(db: Db, arns: string[]): void {
  const stmt = db.prepare('DELETE FROM tag WHERE resource_arn = ?')
  for (const a of arns) stmt.run(a)
}
```

`src/store/events.ts`:
```ts
import type { Db } from './db.ts'
import type { Delivery, EventKind, EventRow } from './types.ts'

type Row = Record<string, any>

const toEvent = (r: Row): EventRow => ({
  id: r.id,
  kind: r.kind,
  wabaId: r.waba_id ?? undefined,
  wamid: r.wamid ?? undefined,
  envelope: JSON.parse(r.envelope),
  deliveries: JSON.parse(r.deliveries),
  at: r.at,
})

export function insertEvent(db: Db, e: EventRow): void {
  db.prepare('INSERT INTO event (id, kind, waba_id, wamid, envelope, deliveries, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    e.id,
    e.kind,
    e.wabaId ?? null,
    e.wamid ?? null,
    JSON.stringify(e.envelope),
    JSON.stringify(e.deliveries),
    e.at,
  )
}

export function setDeliveries(db: Db, id: string, deliveries: Delivery[]): void {
  db.prepare('UPDATE event SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id)
}

export function listEvents(db: Db, f: { kind?: EventKind; wamid?: string; limit?: number }): EventRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.kind) where.push('kind = ?'), args.push(f.kind)
  if (f.wamid) where.push('wamid = ?'), args.push(f.wamid)
  const sql = `SELECT * FROM event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`
  return (db.prepare(sql).all(...args, f.limit ?? 200) as Row[]).map(toEvent)
}
```

- [ ] **Step 7: Implement seeding**

`src/store/seed.ts`:
```ts
import type { Config, WabaSeed } from '../config.ts'
import { metaNumericId, phoneArn, phoneAwsId, wabaArn, wabaAwsId } from '../domain/ids.ts'
import type { Db } from './db.ts'
import { insertTemplate } from './templates.ts'
import type { RegistrationStatus, TemplateRow, WabaRow } from './types.ts'
import { getWabaByMeta, insertPhone, insertWaba } from './wabas.ts'

export function createWaba(db: Db, cfg: { region: string; accountId: string }, seed: WabaSeed, now: number, status: RegistrationStatus = 'COMPLETE'): WabaRow {
  const metaWabaId = seed.metaWabaId ?? metaNumericId()
  const id = wabaAwsId(metaWabaId)
  const waba: WabaRow = {
    id,
    arn: wabaArn(cfg.region, cfg.accountId, id),
    metaWabaId,
    name: seed.name,
    registrationStatus: status,
    linkDate: now,
    eventDestinations: (seed.eventDestinations ?? []).map((eventDestinationArn) => ({ eventDestinationArn })),
  }
  insertWaba(db, waba)
  for (const p of seed.phoneNumbers ?? []) {
    const metaPhoneNumberId = p.metaPhoneNumberId ?? metaNumericId()
    const phoneId = phoneAwsId(metaPhoneNumberId)
    insertPhone(db, {
      id: phoneId,
      arn: phoneArn(cfg.region, cfg.accountId, phoneId),
      wabaId: id,
      metaPhoneNumberId,
      phoneNumber: p.phoneNumber,
      displayPhoneNumber: p.phoneNumber,
      displayName: p.displayName,
      qualityRating: p.qualityRating ?? 'GREEN',
      dataLocalizationRegion: p.dataLocalizationRegion,
    })
  }
  for (const t of seed.templates ?? []) {
    insertTemplate(db, {
      metaTemplateId: metaNumericId(),
      wabaId: id,
      name: t.name,
      language: t.language,
      category: t.category.toUpperCase(),
      status: t.status ?? 'APPROVED',
      parameterFormat: (t.parameterFormat ?? 'POSITIONAL').toUpperCase(),
      components: t.components as TemplateRow['components'],
      createdAt: now,
      updatedAt: now,
    })
  }
  return waba
}

export function seedFromConfig(db: Db, config: Config, now: number): void {
  for (const seed of config.wabas) {
    if (seed.metaWabaId && getWabaByMeta(db, seed.metaWabaId)) continue
    createWaba(db, config, seed, now)
  }
}
```

- [ ] **Step 8: Write the example config**

`eum-social-local-emulator.example.yaml`:
```yaml
# eum-social-local-emulator configuration. Copy to eum-social-local-emulator.yaml (or point EUM_CONFIG at it).
region: ap-south-1
accountId: "000000000000"

# LocalStack (or any AWS-compatible endpoint) for the SNS event sink and S3 media.
# Override with EUM_AWS_ENDPOINT. Omit to disable both.
aws:
  endpoint: http://localhost:4566

wabas:
  - name: Example Business
    metaWabaId: "100000000000001"
    eventDestinations:
      - arn:aws:sns:ap-south-1:000000000000:eum-whatsapp-events
    phoneNumbers:
      - phoneNumber: "+919800000001"
        displayName: Example Sender
        metaPhoneNumberId: "200000000000001"
    templates:
      - name: invoice_reminder
        language: en
        category: UTILITY
        components:
          - type: BODY
            text: "Hi {{1}}, invoice {{2}} of {{3}} is due on {{4}}."

templates:
  autoApproveSeconds: 0        # 0 = approve right away; -1 = approve manually in the UI

sim:
  defaultFlow: [sent, delivered, read]
  stepDelayMs: 1000
  rules:
    - match: { to: "*0000" }
      outcome: { status: failed, code: 131026 }
    - match: { to: "*1111" }
      outcome: { flow: [sent, delivered] }

messageIdMode: uuid            # uuid | wamid (see spec §10)
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts src/domain src/store eum-social-local-emulator.example.yaml test/config.test.ts test/store
git commit -m "feat: config, stable ids, SQLite store and seeding"
```

---

### Task 5: Clock, event envelope, sinks and bus

**Files:**
- Create: `src/sim/clock.ts`, `src/events/envelope.ts`, `src/events/sinks.ts`, `src/events/bus.ts`
- Test: `test/events/envelope.test.ts`, `test/events/bus.test.ts`, `test/sim/clock.test.ts`

**Interfaces:**
- Consumes: store repos/types (Task 4), `MetaError`, `META_ERRORS_HREF`, `digits` (Task 4)
- Produces:
  - `interface Clock { now(): number; schedule(ms: number, fn: () => void | Promise<void>): void; cancelAll(): void }`, `class RealClock implements Clock`, `class FakeClock implements Clock { constructor(start?: number); advance(ms: number): Promise<void>; pending(): number }`
  - `interface Envelope { context: { MetaWabaIds: { wabaId: string; arn: string }[]; MetaPhoneNumberIds: { metaPhoneNumberId: string; arn: string }[] }; whatsAppWebhookEntry: string; aws_account_id: string; message_timestamp: string; messageId: string }`
  - `interface WebhookChange { field: 'messages' | 'message_template_status_update'; value: Record<string, unknown> }`
  - `buildEnvelope(a: { waba: WabaRow; phone?: PhoneRow; change: WebhookChange; accountId: string; now: number }): Envelope`, `isoNanos(ms: number): string`
  - `statusValue(phone: PhoneRow, msg: { wamid: string; peer: string }, status: StatusName, at: number, failure?: MetaError, category?: string)`, `inboundValue(phone: PhoneRow, m: { wamid: string; from: string; name: string; type: string; payload: Record<string, unknown>; at: number })`, `templateStatusValue(t: TemplateRow, event: string, reason?: string)`
  - `interface Sink { name: string; accepts(arn: string): boolean; publish(arn: string, envelope: Envelope): Promise<string> }`, `snsSink(endpoint: string, region: string): Sink`
  - `type BusEvent = { type: 'message'; message: MessageRow } | { type: 'status'; wamid: string; status: string } | { type: 'event'; event: EventRow } | { type: 'template'; template: TemplateRow } | { type: 'waba' } | { type: 'reset' }`
  - `class EventBus { constructor(o: { db: Db; sinks: Sink[]; accountId: string; webhookUrl?: string; log: { error(obj: unknown, msg?: string): void } }); subscribe(fn: (e: BusEvent) => void): () => void; notify(e: BusEvent): void; emit(a: { kind: EventKind; waba: WabaRow; phone?: PhoneRow; wamid?: string; change: WebhookChange; now: number }): Promise<EventRow> }`

- [ ] **Step 1: Write the failing tests**

`test/sim/clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/sim/clock.ts'

describe('FakeClock', () => {
  it('runs due tasks in time order and awaits async tasks', async () => {
    const clock = new FakeClock(1000)
    const seen: string[] = []
    clock.schedule(200, async () => { seen.push(`b@${clock.now()}`) })
    clock.schedule(100, () => { seen.push(`a@${clock.now()}`); clock.schedule(50, () => { seen.push(`c@${clock.now()}`) }) })
    clock.schedule(500, () => { seen.push('late') })
    await clock.advance(300)
    expect(seen).toEqual(['a@1100', 'c@1150', 'b@1200'])
    expect(clock.now()).toBe(1300)
    expect(clock.pending()).toBe(1)
    clock.cancelAll()
    await clock.advance(1000)
    expect(seen).not.toContain('late')
  })
})
```

`test/events/envelope.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { metaError } from '../../src/domain/metaErrors.ts'
import { buildEnvelope, inboundValue, isoNanos, statusValue, templateStatusValue } from '../../src/events/envelope.ts'
import type { PhoneRow, TemplateRow, WabaRow } from '../../src/store/types.ts'

const waba: WabaRow = { id: 'waba-aa', arn: 'arn:aws:social-messaging:ap-south-1:000000000000:waba/aa', metaWabaId: '111', name: 'W', registrationStatus: 'COMPLETE', linkDate: 0, eventDestinations: [] }
const phone: PhoneRow = { id: 'phone-number-id-bb', arn: 'arn:aws:social-messaging:ap-south-1:000000000000:phone-number-id/bb', wabaId: 'waba-aa', metaPhoneNumberId: '222', phoneNumber: '+919800000001', displayPhoneNumber: '+919800000001', displayName: 'P', qualityRating: 'GREEN' }
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0, 123)

describe('envelope', () => {
  it('matches the documented AWS EUM header', () => {
    const env = buildEnvelope({ waba, phone, accountId: '000000000000', now: NOW, change: { field: 'messages', value: { x: 1 } } })
    expect(env).toEqual({
      context: { MetaWabaIds: [{ wabaId: '111', arn: waba.arn }], MetaPhoneNumberIds: [{ metaPhoneNumberId: '222', arn: phone.arn }] },
      whatsAppWebhookEntry: JSON.stringify({ id: '111', changes: [{ field: 'messages', value: { x: 1 } }] }),
      aws_account_id: '000000000000',
      message_timestamp: '2026-10-07T10:00:00.123000000Z',
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(typeof env.whatsAppWebhookEntry).toBe('string')
  })

  it('omits phone context for template events', () => {
    expect(buildEnvelope({ waba, accountId: '0', now: 0, change: { field: 'message_template_status_update', value: {} } }).context.MetaPhoneNumberIds).toEqual([])
  })

  it('builds status values with pricing for sent and errors for failed', () => {
    const sent = statusValue(phone, { wamid: 'wamid.X', peer: '+15550001' }, 'sent', NOW, undefined, 'utility')
    expect(sent).toEqual({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '919800000001', phone_number_id: '222' },
      statuses: [{ id: 'wamid.X', status: 'sent', timestamp: String(Math.floor(NOW / 1000)), recipient_id: '15550001', pricing: { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' } }],
    })
    const failed = statusValue(phone, { wamid: 'wamid.X', peer: '+15550001' }, 'failed', NOW, metaError(131047))
    expect((failed.statuses as any[])[0].errors[0]).toMatchObject({ code: 131047, title: 'Re-engagement message' })
    expect((failed.statuses as any[])[0]).not.toHaveProperty('pricing')
  })

  it('builds inbound and template status values', () => {
    const v = inboundValue(phone, { wamid: 'wamid.I', from: '+15550001', name: 'Asha', type: 'text', payload: { text: { body: 'STOP' } }, at: NOW })
    expect(v).toMatchObject({
      contacts: [{ profile: { name: 'Asha' }, wa_id: '15550001' }],
      messages: [{ from: '15550001', id: 'wamid.I', type: 'text', text: { body: 'STOP' } }],
    })
    const t = { metaTemplateId: '123456789012345', name: 'hello', language: 'en' } as TemplateRow
    expect(templateStatusValue(t, 'REJECTED', 'INVALID_FORMAT')).toEqual({
      event: 'REJECTED', message_template_id: 123456789012345, message_template_name: 'hello', message_template_language: 'en', reason: 'INVALID_FORMAT',
    })
  })

  it('formats nanosecond timestamps', () => {
    expect(isoNanos(0)).toBe('1970-01-01T00:00:00.000000000Z')
  })
})
```

`test/events/bus.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { EventBus, type BusEvent, type Sink } from '../../src/events/bus.ts'
import { openDb } from '../../src/store/db.ts'
import { listEvents } from '../../src/store/events.ts'
import { createWaba } from '../../src/store/seed.ts'

const config = parseConfig(undefined, {})
const quietLog = { error: () => {} }

function setup(sinks: Sink[], destinations: string[]) {
  const db = openDb(':memory:')
  const waba = createWaba(db, config, { name: 'W', metaWabaId: '1', eventDestinations: destinations }, 0)
  const bus = new EventBus({ db, sinks, accountId: '000000000000', log: quietLog })
  return { db, waba, bus }
}

describe('EventBus', () => {
  it('stores the event, publishes to matching sinks and notifies subscribers', async () => {
    const published: string[] = []
    const sink: Sink = { name: 'cap', accepts: (a) => a.startsWith('arn:aws:sns:'), publish: async (arn) => { published.push(arn); return 'msg-1' } }
    const { db, waba, bus } = setup([sink], ['arn:aws:sns:ap-south-1:000000000000:t', 'arn:aws:connect:ap-south-1:000000000000:instance/x'])
    const seen: BusEvent[] = []
    bus.subscribe((e) => seen.push(e))
    const row = await bus.emit({ kind: 'status', waba, now: 5, change: { field: 'messages', value: {} } })
    expect(published).toEqual(['arn:aws:sns:ap-south-1:000000000000:t'])
    expect(row.deliveries).toEqual([
      { destination: 'arn:aws:sns:ap-south-1:000000000000:t', ok: true, detail: 'msg-1' },
      { destination: 'arn:aws:connect:ap-south-1:000000000000:instance/x', ok: false, detail: 'skipped: unsupported destination' },
    ])
    expect(listEvents(db, {})[0].deliveries).toEqual(row.deliveries)
    expect(seen.map((e) => e.type)).toEqual(['event'])
  })

  it('records a failing sink without throwing (Review Focus 3)', async () => {
    const sink: Sink = { name: 'down', accepts: () => true, publish: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4566') } }
    const { bus, waba } = setup([sink], ['arn:aws:sns:ap-south-1:000000000000:t'])
    const row = await bus.emit({ kind: 'status', waba, now: 0, change: { field: 'messages', value: {} } })
    expect(row.deliveries[0]).toEqual({ destination: 'arn:aws:sns:ap-south-1:000000000000:t', ok: false, detail: 'connect ECONNREFUSED 127.0.0.1:4566' })
  })

  it('unsubscribes', () => {
    const { bus } = setup([], [])
    let n = 0
    const off = bus.subscribe(() => n++)
    bus.notify({ type: 'waba' })
    off()
    bus.notify({ type: 'waba' })
    expect(n).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sim test/events`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the clock**

`src/sim/clock.ts`:
```ts
export interface Clock {
  now(): number
  schedule(ms: number, fn: () => void | Promise<void>): void
  cancelAll(): void
}

export class RealClock implements Clock {
  private timers = new Set<ReturnType<typeof setTimeout>>()

  now(): number {
    return Date.now()
  }

  schedule(ms: number, fn: () => void | Promise<void>): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error('eum-social-local-emulator: scheduled task failed', err))
    }, ms)
    this.timers.add(t)
  }

  cancelAll(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
}

interface Task {
  at: number
  seq: number
  fn: () => void | Promise<void>
}

// Deterministic clock for tests: time only moves when advance() is called.
export class FakeClock implements Clock {
  private t: number
  private seq = 0
  private tasks: Task[] = []

  constructor(start = Date.UTC(2026, 9, 7, 10, 0, 0)) {
    this.t = start
  }

  now(): number {
    return this.t
  }

  schedule(ms: number, fn: () => void | Promise<void>): void {
    this.tasks.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn })
  }

  cancelAll(): void {
    this.tasks = []
  }

  pending(): number {
    return this.tasks.length
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.tasks[0]
      if (!next || next.at > end) break
      this.tasks.shift()
      this.t = next.at
      await next.fn()
    }
    this.t = end
  }
}
```

- [ ] **Step 4: Implement the envelope**

`src/events/envelope.ts`:
```ts
import { randomUUID } from 'node:crypto'
import type { StatusName } from '../config.ts'
import { digits } from '../domain/ids.ts'
import { META_ERRORS_HREF, type MetaError } from '../domain/metaErrors.ts'
import type { PhoneRow, TemplateRow, WabaRow } from '../store/types.ts'

export interface Envelope {
  context: {
    MetaWabaIds: { wabaId: string; arn: string }[]
    MetaPhoneNumberIds: { metaPhoneNumberId: string; arn: string }[]
  }
  whatsAppWebhookEntry: string
  aws_account_id: string
  message_timestamp: string
  messageId: string
}

export interface WebhookChange {
  field: 'messages' | 'message_template_status_update'
  value: Record<string, unknown>
}

export const isoNanos = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')

export function buildEnvelope(a: { waba: WabaRow; phone?: PhoneRow; change: WebhookChange; accountId: string; now: number }): Envelope {
  return {
    context: {
      MetaWabaIds: [{ wabaId: a.waba.metaWabaId, arn: a.waba.arn }],
      MetaPhoneNumberIds: a.phone ? [{ metaPhoneNumberId: a.phone.metaPhoneNumberId, arn: a.phone.arn }] : [],
    },
    whatsAppWebhookEntry: JSON.stringify({ id: a.waba.metaWabaId, changes: [a.change] }),
    aws_account_id: a.accountId,
    message_timestamp: isoNanos(a.now),
    messageId: randomUUID(),
  }
}

const metadata = (phone: PhoneRow) => ({ display_phone_number: digits(phone.phoneNumber), phone_number_id: phone.metaPhoneNumberId })
const seconds = (ms: number) => String(Math.floor(ms / 1000))

export function statusValue(
  phone: PhoneRow,
  msg: { wamid: string; peer: string },
  status: StatusName,
  at: number,
  failure?: MetaError,
  category?: string,
): Record<string, unknown> {
  const s: Record<string, unknown> = { id: msg.wamid, status, timestamp: seconds(at), recipient_id: digits(msg.peer) }
  if (status === 'sent' || status === 'delivered') {
    const cat = category ?? 'service'
    s.pricing = { billable: cat !== 'service', pricing_model: 'PMP', category: cat, type: 'regular' }
  }
  if (failure) {
    s.errors = [{ code: failure.code, title: failure.title, message: failure.title, error_data: { details: failure.title }, href: META_ERRORS_HREF }]
  }
  return { messaging_product: 'whatsapp', metadata: metadata(phone), statuses: [s] }
}

export function inboundValue(
  phone: PhoneRow,
  m: { wamid: string; from: string; name: string; type: string; payload: Record<string, unknown>; at: number },
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    metadata: metadata(phone),
    contacts: [{ profile: { name: m.name }, wa_id: digits(m.from) }],
    messages: [{ from: digits(m.from), id: m.wamid, timestamp: seconds(m.at), type: m.type, ...m.payload }],
  }
}

export function templateStatusValue(t: TemplateRow, event: string, reason?: string): Record<string, unknown> {
  return {
    event,
    message_template_id: Number(t.metaTemplateId),
    message_template_name: t.name,
    message_template_language: t.language,
    reason: reason ?? 'NONE',
  }
}
```

- [ ] **Step 5: Implement sinks and the bus**

`src/events/sinks.ts`:
```ts
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import type { Envelope } from './envelope.ts'

export interface Sink {
  name: string
  accepts(arn: string): boolean
  publish(arn: string, envelope: Envelope): Promise<string>
}

export function snsSink(endpoint: string, region: string): Sink {
  const clients = new Map<string, SNSClient>()
  const client = (r: string) => {
    let c = clients.get(r)
    if (!c) {
      c = new SNSClient({ endpoint, region: r, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 })
      clients.set(r, c)
    }
    return c
  }
  return {
    name: 'sns',
    accepts: (arn) => arn.startsWith('arn:aws:sns:'),
    async publish(arn, envelope) {
      const r = arn.split(':')[3] || region
      const out = await client(r).send(new PublishCommand({ TopicArn: arn, Message: JSON.stringify(envelope) }))
      return `sns MessageId ${out.MessageId}`
    },
  }
}
```

`src/events/bus.ts`:
```ts
import type { Db } from '../store/db.ts'
import { insertEvent, setDeliveries } from '../store/events.ts'
import type { EventKind, EventRow, MessageRow, PhoneRow, TemplateRow, WabaRow } from '../store/types.ts'
import { buildEnvelope, type WebhookChange } from './envelope.ts'
import type { Sink } from './sinks.ts'

export type { Sink } from './sinks.ts'

export type BusEvent =
  | { type: 'message'; message: MessageRow }
  | { type: 'status'; wamid: string; status: string }
  | { type: 'event'; event: EventRow }
  | { type: 'template'; template: TemplateRow }
  | { type: 'waba' }
  | { type: 'reset' }

export interface BusOptions {
  db: Db
  sinks: Sink[]
  accountId: string
  webhookUrl?: string
  log: { error(obj: unknown, msg?: string): void }
}

export class EventBus {
  private readonly o: BusOptions
  private readonly subscribers = new Set<(e: BusEvent) => void>()

  constructor(o: BusOptions) {
    this.o = o
  }

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  notify(e: BusEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e)
      } catch (err) {
        this.o.log.error({ err }, 'eum-social-local-emulator: bus subscriber failed')
      }
    }
  }

  // Stores the event, then delivers it to the WABA's destinations. Never throws for sink failures.
  async emit(a: { kind: EventKind; waba: WabaRow; phone?: PhoneRow; wamid?: string; change: WebhookChange; now: number }): Promise<EventRow> {
    const envelope = buildEnvelope({ waba: a.waba, phone: a.phone, change: a.change, accountId: this.o.accountId, now: a.now })
    const row: EventRow = { id: envelope.messageId, kind: a.kind, wabaId: a.waba.id, wamid: a.wamid, envelope, deliveries: [], at: a.now }
    insertEvent(this.o.db, row)
    for (const { eventDestinationArn: arn } of a.waba.eventDestinations) {
      const sink = this.o.sinks.find((s) => s.accepts(arn))
      if (!sink) {
        row.deliveries.push({ destination: arn, ok: false, detail: 'skipped: unsupported destination' })
        continue
      }
      try {
        row.deliveries.push({ destination: arn, ok: true, detail: await sink.publish(arn, envelope) })
      } catch (err) {
        row.deliveries.push({ destination: arn, ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    if (this.o.webhookUrl) {
      try {
        const res = await fetch(this.o.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
        row.deliveries.push({ destination: this.o.webhookUrl, ok: res.ok, detail: `HTTP ${res.status}` })
      } catch (err) {
        row.deliveries.push({ destination: this.o.webhookUrl, ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    setDeliveries(this.o.db, row.id, row.deliveries)
    this.notify({ type: 'event', event: row })
    return row
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sim/clock.ts src/events test/sim test/events
git commit -m "feat: EUM event envelope, SNS sink, event bus and clocks"
```

---

### Task 6: WhatsApp domain rules (templates, window, outcome rules)

**Files:**
- Create: `src/domain/templates.ts`, `src/domain/render.ts`, `src/sim/rules.ts`, `src/sim/window.ts`
- Test: `test/domain/templates.test.ts`, `test/sim/rules.test.ts`

**Interfaces:**
- Consumes: `TemplateRow`, `TemplateComponent` (Task 4), `MetaError`, `metaError` (Task 4), `SimRule`, `StatusName` (Task 4)
- Produces:
  - `placeholders(text: string): string[]`, `bodyText(components: TemplateComponent[]): string | undefined`, `suppliedParams(sendTemplate: any): { positional: string[]; named: Record<string, string> }`, `renderTemplate(t: TemplateRow, sendTemplate: any): string`, `checkTemplateSend(t: TemplateRow | undefined, body: any): MetaError | null`, `validateTemplateName(name: unknown): string | null`
  - `renderOutbound(body: any, template: TemplateRow | undefined): string`
  - `interface Outcome { flow: StatusName[]; failure?: MetaError }`, `globMatch(pattern: string, value: string): boolean`, `decideOutcome(rules: SimRule[], defaultFlow: StatusName[], msg: { to: string; type: string; template?: string }): Outcome`
  - `WINDOW_MS`, `windowOpen(lastInboundAt: number | undefined, now: number): boolean`

- [ ] **Step 1: Write the failing tests**

`test/domain/templates.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderOutbound } from '../../src/domain/render.ts'
import { checkTemplateSend, placeholders, renderTemplate, suppliedParams, validateTemplateName } from '../../src/domain/templates.ts'
import type { TemplateRow } from '../../src/store/types.ts'

const tpl = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  metaTemplateId: '1', wabaId: 'w', name: 'invoice_reminder', language: 'en', category: 'UTILITY', status: 'APPROVED', parameterFormat: 'POSITIONAL',
  components: [{ type: 'HEADER', format: 'TEXT', text: 'Reminder' }, { type: 'BODY', text: 'Hi {{1}}, invoice {{2}} is due {{3}}. Thanks {{1}}' }],
  createdAt: 0, updatedAt: 0, ...over,
})
const send = (params: unknown[]) => ({ name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: params }] })

describe('templates', () => {
  it('counts distinct placeholders', () => {
    expect(placeholders('Hi {{1}}, {{2}} and {{ 1 }} {{name}}')).toEqual(['1', '2', 'name'])
  })

  it('extracts body parameters of every Meta parameter type', () => {
    expect(suppliedParams(send([
      { type: 'text', text: 'Asha' },
      { type: 'currency', currency: { fallback_value: '₹1,200', code: 'INR', amount_1000: 1200000 } },
      { type: 'date_time', date_time: { fallback_value: 'Oct 9' } },
      { type: 'text', text: 'Ravi', parameter_name: 'agent' },
    ]))).toEqual({ positional: ['Asha', '₹1,200', 'Oct 9'], named: { agent: 'Ravi' } })
    expect(suppliedParams(undefined)).toEqual({ positional: [], named: {} })
  })

  it('renders positional and named templates', () => {
    expect(renderTemplate(tpl(), send([{ type: 'text', text: 'Asha' }, { type: 'text', text: 'INV-1' }, { type: 'text', text: 'Friday' }])))
      .toBe('Hi Asha, invoice INV-1 is due Friday. Thanks Asha')
    const named = tpl({ parameterFormat: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{first_name}}' }] })
    expect(renderTemplate(named, send([{ type: 'text', text: 'Asha', parameter_name: 'first_name' }]))).toBe('Hi Asha')
  })

  it('applies Meta asynchronous template checks', () => {
    expect(checkTemplateSend(undefined, { template: send([]) })).toMatchObject({ code: 132001 })
    expect(checkTemplateSend(tpl({ status: 'PENDING' }), { template: send([]) })).toMatchObject({ code: 132001 })
    expect(checkTemplateSend(tpl(), { template: send([{ type: 'text', text: 'a' }]) })).toMatchObject({ code: 132000 })
    expect(checkTemplateSend(tpl(), { template: send([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }]) })).toBeNull()
  })

  it('validates template names', () => {
    expect(validateTemplateName('invoice_reminder_2')).toBeNull()
    expect(validateTemplateName('Invoice Reminder')).toMatch(/lowercase/)
    expect(validateTemplateName('')).toMatch(/lowercase/)
  })

  it('renders outbound bodies for the inbox', () => {
    expect(renderOutbound({ type: 'text', text: { body: 'hello' } }, undefined)).toBe('hello')
    expect(renderOutbound({ type: 'image', image: { link: 'x', caption: 'Invoice' } }, undefined)).toBe('[image] Invoice')
    expect(renderOutbound({ type: 'reaction', reaction: { emoji: '👍' } }, undefined)).toBe('reacted 👍')
    expect(renderOutbound({ type: 'template', template: { name: 'nope', language: { code: 'en' } } }, undefined)).toBe('[template nope/en not found]')
    expect(renderOutbound({ type: 'location' }, undefined)).toBe('[location]')
  })
})
```

`test/sim/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decideOutcome, globMatch } from '../../src/sim/rules.ts'
import { WINDOW_MS, windowOpen } from '../../src/sim/window.ts'

describe('outcome rules', () => {
  it('matches globs literally apart from * and ?', () => {
    expect(globMatch('*0000', '+919800000000')).toBe(true)
    expect(globMatch('+91*', '+15550000')).toBe(false)
    expect(globMatch('+1555000?', '+15550001')).toBe(true)
    expect(globMatch('+1.5', '+125')).toBe(false)
  })

  it('takes the first matching rule, else the default flow', () => {
    const rules = [
      { match: { to: '*0000' }, outcome: { status: 'failed' as const, code: 131026 } },
      { match: { to: '*1111', type: 'template' }, outcome: { flow: ['sent' as const, 'delivered' as const] } },
      { match: { template: 'promo' }, outcome: { status: 'failed' as const, code: 131050 } },
    ]
    const dflt = ['sent', 'delivered', 'read'] as const
    expect(decideOutcome(rules, [...dflt], { to: '+10000', type: 'text' })).toEqual({ flow: ['failed'], failure: { code: 131026, title: 'Message undeliverable' } })
    expect(decideOutcome(rules, [...dflt], { to: '+11111', type: 'template' })).toEqual({ flow: ['sent', 'delivered'], failure: undefined })
    expect(decideOutcome(rules, [...dflt], { to: '+11111', type: 'text' })).toEqual({ flow: ['sent', 'delivered', 'read'] })
    expect(decideOutcome(rules, [...dflt], { to: '+12', type: 'template', template: 'promo' }).failure?.code).toBe(131050)
  })

  it('treats a 24h window as open only after a recent inbound', () => {
    expect(windowOpen(undefined, 1000)).toBe(false)
    expect(windowOpen(0, WINDOW_MS - 1)).toBe(true)
    expect(windowOpen(0, WINDOW_MS)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/domain test/sim/rules.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement template rules and rendering**

`src/domain/templates.ts`:
```ts
import type { TemplateComponent, TemplateRow } from '../store/types.ts'
import { metaError, type MetaError } from './metaErrors.ts'

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]
}

export const bodyText = (components: TemplateComponent[]): string | undefined =>
  components.find((c) => String(c.type).toUpperCase() === 'BODY')?.text

export function suppliedParams(sendTemplate: any): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = []
  const named: Record<string, string> = {}
  const body = (sendTemplate?.components ?? []).find((c: any) => String(c?.type).toLowerCase() === 'body')
  for (const p of body?.parameters ?? []) {
    const value = String(p?.text ?? p?.currency?.fallback_value ?? p?.date_time?.fallback_value ?? `[${p?.type}]`)
    if (p?.parameter_name) named[p.parameter_name] = value
    else positional.push(value)
  }
  return { positional, named }
}

export function renderTemplate(t: TemplateRow, sendTemplate: any): string {
  const { positional, named } = suppliedParams(sendTemplate)
  return (bodyText(t.components) ?? '').replace(PLACEHOLDER, (whole, key: string) =>
    /^\d+$/.test(key) ? (positional[Number(key) - 1] ?? whole) : (named[key] ?? whole),
  )
}

// Meta's checks happen after the API call succeeds and arrive as a failed status.
export function checkTemplateSend(t: TemplateRow | undefined, body: any): MetaError | null {
  if (!t || t.status !== 'APPROVED') return metaError(132001)
  const expected = placeholders(bodyText(t.components) ?? '').length
  const p = suppliedParams(body?.template)
  const got = t.parameterFormat === 'NAMED' ? Object.keys(p.named).length : p.positional.length
  return got === expected ? null : metaError(132000)
}

export function validateTemplateName(name: unknown): string | null {
  return typeof name === 'string' && /^[a-z0-9_]{1,512}$/.test(name)
    ? null
    : 'Template name must be 1-512 characters of lowercase letters, digits and underscores'
}
```

`src/domain/render.ts`:
```ts
import type { TemplateRow } from '../store/types.ts'
import { renderTemplate } from './templates.ts'

const MEDIA = new Set(['image', 'document', 'video', 'audio', 'sticker'])

// Human-readable text of an outbound Meta message, for the inbox.
export function renderOutbound(body: any, template: TemplateRow | undefined): string {
  const type = String(body?.type)
  if (type === 'text') return String(body.text?.body ?? '')
  if (type === 'template') {
    return template ? renderTemplate(template, body.template) : `[template ${body.template?.name}/${body.template?.language?.code} not found]`
  }
  if (MEDIA.has(type)) return `[${type}] ${body[type]?.caption ?? body[type]?.filename ?? ''}`.trim()
  if (type === 'reaction') return `reacted ${body.reaction?.emoji ?? ''}`.trim()
  if (type === 'interactive') return String(body.interactive?.body?.text ?? '[interactive]')
  return `[${type}]`
}
```

- [ ] **Step 4: Implement outcome rules and the window**

`src/sim/rules.ts`:
```ts
import type { SimRule, StatusName } from '../config.ts'
import { metaError, type MetaError } from '../domain/metaErrors.ts'

export interface Outcome {
  flow: StatusName[]
  failure?: MetaError
}

export function globMatch(pattern: string, value: string): boolean {
  const re = [...pattern].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${re}$`).test(value)
}

export function decideOutcome(rules: SimRule[], defaultFlow: StatusName[], msg: { to: string; type: string; template?: string }): Outcome {
  for (const { match, outcome } of rules) {
    if (match.to && !globMatch(match.to, msg.to)) continue
    if (match.type && match.type !== msg.type) continue
    if (match.template && match.template !== msg.template) continue
    if (outcome.status === 'failed') return { flow: ['failed'], failure: metaError(outcome.code ?? 131026, outcome.title) }
    const flow = outcome.flow ?? defaultFlow
    return { flow, failure: flow.includes('failed') ? metaError(outcome.code ?? 131026, outcome.title) : undefined }
  }
  return { flow: defaultFlow }
}
```

`src/sim/window.ts`:
```ts
export const WINDOW_MS = 24 * 60 * 60 * 1000

// Free-form (non-template) messages are only allowed within 24h of the customer's last message.
export const windowOpen = (lastInboundAt: number | undefined, now: number): boolean =>
  lastInboundAt !== undefined && now - lastInboundAt < WINDOW_MS
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/templates.ts src/domain/render.ts src/sim/rules.ts src/sim/window.ts test/domain test/sim/rules.test.ts
git commit -m "feat: template checks, rendering, outcome rules and 24h window"
```

---

### Task 7: Simulator

**Files:**
- Create: `src/sim/simulator.ts`
- Test: `test/sim/simulator.test.ts`

**Interfaces:**
- Consumes: `Clock`, `FakeClock` (Task 5), `EventBus` (Task 5), envelope value builders (Task 5), domain rules (Task 6), store repos (Task 4), `Config` (Task 4)
- Produces:
  - `interface InboundInput { phoneNumberId: string; from: string; name?: string; type: 'text' | 'button' | 'image'; text?: string; mediaBase64?: string; mimeType?: string }`
  - `class Simulator { constructor(d: { db: Db; clock: Clock; bus: EventBus; config: Config }); onSend(msg: MessageRow, template: TemplateRow | undefined): void; decide(msg: MessageRow, template: TemplateRow | undefined): Outcome; applyStatus(wamid: string, status: StatusName, failure?: MetaError): Promise<MessageRow | undefined>; inbound(i: InboundInput): Promise<MessageRow>; scheduleTemplateApproval(t: TemplateRow): void; setTemplateStatus(metaTemplateId: string, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<TemplateRow>; resumePendingTemplates(): void }`
  - `inbound` and `setTemplateStatus` throw plain `Error` with message `unknown phone number <id>` / `unknown template <id>` (the admin API maps these to 404).

- [ ] **Step 1: Write the failing test**

`test/sim/simulator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseConfig, type Config } from '../../src/config.ts'
import { phoneAwsId, wabaAwsId } from '../../src/domain/ids.ts'
import { EventBus } from '../../src/events/bus.ts'
import { FakeClock } from '../../src/sim/clock.ts'
import { Simulator } from '../../src/sim/simulator.ts'
import { openDb } from '../../src/store/db.ts'
import { listEvents } from '../../src/store/events.ts'
import { getMessage, insertMessage } from '../../src/store/messages.ts'
import { seedFromConfig } from '../../src/store/seed.ts'
import { findTemplate, getTemplateById } from '../../src/store/templates.ts'
import type { MessageRow } from '../../src/store/types.ts'

const YAML = `
wabas:
  - name: W
    metaWabaId: "1"
    eventDestinations: [arn:aws:sns:ap-south-1:000000000000:t]
    phoneNumbers: [{ phoneNumber: "+919800000001", displayName: P, metaPhoneNumberId: "2" }]
    templates:
      - { name: hello, language: en, category: UTILITY, components: [{ type: BODY, text: "Hi {{1}}" }] }
sim:
  stepDelayMs: 1000
  rules:
    - { match: { to: "*0000" }, outcome: { status: failed, code: 131026 } }
`
const PHONE = phoneAwsId('2')

function setup(over: Partial<Config> = {}) {
  const config = { ...parseConfig(YAML, {}), ...over }
  const db = openDb(':memory:')
  seedFromConfig(db, config, 0)
  const clock = new FakeClock()
  const bus = new EventBus({ db, sinks: [], accountId: '000000000000', log: { error: () => {} } })
  const sim = new Simulator({ db, clock, bus, config })
  return { db, clock, sim, config }
}

function out(db: ReturnType<typeof openDb>, clock: FakeClock, body: any, peer = '+15550001'): MessageRow {
  const m: MessageRow = { wamid: `wamid.${Math.random().toString(36).slice(2)}`, phoneNumberId: PHONE, direction: 'out', peer, type: body.type, body, status: 'accepted', createdAt: clock.now() }
  insertMessage(db, m)
  return m
}

const templateBody = (params: string[]) => ({ type: 'template', template: { name: 'hello', language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } })

describe('Simulator', () => {
  it('walks the default flow one step per stepDelayMs', async () => {
    const { db, clock, sim } = setup()
    const m = out(db, clock, templateBody(['Asha']))
    sim.onSend(m, findTemplate(db, wabaAwsId('1'), 'hello', 'en'))
    await clock.advance(1000)
    expect(getMessage(db, m.wamid)?.status).toBe('sent')
    await clock.advance(2000)
    expect(getMessage(db, m.wamid)?.status).toBe('read')
    expect(listEvents(db, { kind: 'status' }).map((e) => JSON.parse(e.envelope.whatsAppWebhookEntry).changes[0].value.statuses[0].status)).toEqual(['read', 'delivered', 'sent'])
  })

  it('fails templates Meta would reject, before any rule', async () => {
    const { db, clock, sim } = setup()
    const tpl = findTemplate(db, wabaAwsId('1'), 'hello', 'en')
    expect(sim.decide(out(db, clock, templateBody([])), tpl)).toMatchObject({ flow: ['failed'], failure: { code: 132000 } })
    expect(sim.decide(out(db, clock, templateBody(['a'])), undefined)).toMatchObject({ failure: { code: 132001 } })
  })

  it('fails free-form text outside the 24h window and allows it after an inbound', async () => {
    const { db, clock, sim } = setup()
    expect(sim.decide(out(db, clock, { type: 'text', text: { body: 'hi' } }), undefined)).toMatchObject({ failure: { code: 131047 } })
    await sim.inbound({ phoneNumberId: PHONE, from: '+15550001', type: 'text', text: 'hello' })
    expect(sim.decide(out(db, clock, { type: 'text', text: { body: 'hi' } }), undefined)).toEqual({ flow: ['sent', 'delivered', 'read'] })
  })

  it('applies configured rules', () => {
    const { db, clock, sim } = setup()
    expect(sim.decide(out(db, clock, templateBody(['a']), '+919800000000'), findTemplate(db, wabaAwsId('1'), 'hello', 'en'))).toMatchObject({ failure: { code: 131026 } })
  })

  it('records an inbound message and emits a messages event with contacts', async () => {
    const { db, sim } = setup()
    const m = await sim.inbound({ phoneNumberId: PHONE, from: '15550001', name: 'Asha', type: 'text', text: 'STOP' })
    expect(m).toMatchObject({ direction: 'in', peer: '+15550001', renderedText: 'STOP', status: 'received' })
    const v = JSON.parse(listEvents(db, { kind: 'inbound' })[0].envelope.whatsAppWebhookEntry).changes[0].value
    expect(v.messages[0]).toMatchObject({ from: '15550001', type: 'text', text: { body: 'STOP' } })
  })

  it('stores inbound images as media', async () => {
    const { sim } = setup()
    const m = await sim.inbound({ phoneNumberId: PHONE, from: '+15550001', type: 'image', mediaBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png' })
    expect(m.body.image).toMatchObject({ mime_type: 'image/png', id: expect.stringMatching(/^\d+$/) })
  })

  it('ignores statuses for messages that no longer exist (Review Focus 2)', async () => {
    const { sim } = setup()
    await expect(sim.applyStatus('wamid.gone', 'sent')).resolves.toBeUndefined()
  })

  it('auto-approves PENDING templates and emits template status events', async () => {
    const { db, clock, sim } = setup({ templates: { autoApproveSeconds: 5 } })
    const t = findTemplate(db, wabaAwsId('1'), 'hello', 'en')!
    db.prepare("UPDATE template SET status = 'PENDING' WHERE meta_template_id = ?").run(t.metaTemplateId)
    sim.scheduleTemplateApproval({ ...t, status: 'PENDING' })
    await clock.advance(4999)
    expect(getTemplateById(db, t.metaTemplateId)?.status).toBe('PENDING')
    await clock.advance(1)
    expect(getTemplateById(db, t.metaTemplateId)?.status).toBe('APPROVED')
    expect(JSON.parse(listEvents(db, { kind: 'template_status' })[0].envelope.whatsAppWebhookEntry).changes[0]).toMatchObject({ field: 'message_template_status_update', value: { event: 'APPROVED' } })
  })

  it('never auto-approves when autoApproveSeconds is -1', async () => {
    const { db, clock, sim } = setup({ templates: { autoApproveSeconds: -1 } })
    const t = findTemplate(db, wabaAwsId('1'), 'hello', 'en')!
    sim.scheduleTemplateApproval({ ...t, status: 'PENDING' })
    expect(clock.pending()).toBe(0)
  })

  it('rejects unknown phone numbers on inbound', async () => {
    const { sim } = setup()
    await expect(sim.inbound({ phoneNumberId: 'phone-number-id-x', from: '+1', type: 'text', text: 'x' })).rejects.toThrow(/unknown phone number/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sim/simulator.test.ts`
Expected: FAIL — `simulator.ts` not found.

- [ ] **Step 3: Implement the simulator**

`src/sim/simulator.ts`:
```ts
import { createHash } from 'node:crypto'
import type { Config, StatusName } from '../config.ts'
import { metaNumericId, msisdn, newWamid } from '../domain/ids.ts'
import { metaError, type MetaError } from '../domain/metaErrors.ts'
import { checkTemplateSend } from '../domain/templates.ts'
import type { EventBus } from '../events/bus.ts'
import { inboundValue, statusValue, templateStatusValue } from '../events/envelope.ts'
import type { Db } from '../store/db.ts'
import { insertMedia } from '../store/media.ts'
import { getMessage, insertMessage, lastInboundAt, updateMessageStatus } from '../store/messages.ts'
import { getTemplateById, listPendingTemplates, setTemplateStatus } from '../store/templates.ts'
import type { MessageRow, TemplateRow } from '../store/types.ts'
import { getPhone, getWaba } from '../store/wabas.ts'
import type { Clock } from './clock.ts'
import { decideOutcome, type Outcome } from './rules.ts'
import { windowOpen } from './window.ts'

export interface InboundInput {
  phoneNumberId: string
  from: string
  name?: string
  type: 'text' | 'button' | 'image'
  text?: string
  mediaBase64?: string
  mimeType?: string
}

interface SimDeps {
  db: Db
  clock: Clock
  bus: EventBus
  config: Config
}

export class Simulator {
  private readonly d: SimDeps

  constructor(d: SimDeps) {
    this.d = d
  }

  onSend(msg: MessageRow, template: TemplateRow | undefined): void {
    const outcome = this.decide(msg, template)
    outcome.flow.forEach((status, i) => {
      this.d.clock.schedule((i + 1) * this.d.config.sim.stepDelayMs, async () => {
        await this.applyStatus(msg.wamid, status, status === 'failed' ? outcome.failure : undefined)
      })
    })
  }

  decide(msg: MessageRow, template: TemplateRow | undefined): Outcome {
    if (msg.type === 'template') {
      const failure = checkTemplateSend(template, msg.body)
      if (failure) return { flow: ['failed'], failure }
    } else if (!windowOpen(lastInboundAt(this.d.db, msg.phoneNumberId, msg.peer), this.d.clock.now())) {
      return { flow: ['failed'], failure: metaError(131047) }
    }
    return decideOutcome(this.d.config.sim.rules, this.d.config.sim.defaultFlow, {
      to: msg.peer,
      type: msg.type,
      template: msg.body?.template?.name,
    })
  }

  // Returns undefined when the message (or its phone/WABA) has since been removed.
  async applyStatus(wamid: string, status: StatusName, failure?: MetaError): Promise<MessageRow | undefined> {
    const { db, clock, bus } = this.d
    const msg = getMessage(db, wamid)
    const phone = msg && getPhone(db, msg.phoneNumberId)
    const waba = phone && getWaba(db, phone.wabaId)
    if (!msg || !phone || !waba) return undefined
    const now = clock.now()
    const f = status === 'failed' ? (failure ?? metaError(131026)) : undefined
    updateMessageStatus(db, wamid, status, f, now)
    await bus.emit({ kind: 'status', waba, phone, wamid, now, change: { field: 'messages', value: statusValue(phone, msg, status, now, f, msg.category) } })
    bus.notify({ type: 'status', wamid, status })
    return getMessage(db, wamid)
  }

  async inbound(i: InboundInput): Promise<MessageRow> {
    const { db, clock, bus } = this.d
    const phone = getPhone(db, i.phoneNumberId)
    const waba = phone && getWaba(db, phone.wabaId)
    if (!phone || !waba) throw new Error(`unknown phone number ${i.phoneNumberId}`)
    const peer = msisdn(i.from)
    if (!peer) throw new Error(`invalid customer number ${i.from}`)
    const now = clock.now()
    const wamid = newWamid()
    let payload: Record<string, unknown>
    let renderedText = i.text ?? ''
    if (i.type === 'image') {
      const bytes = Buffer.from(i.mediaBase64 ?? '', 'base64')
      const mimeType = i.mimeType ?? 'image/jpeg'
      const mediaId = metaNumericId()
      const sha256 = createHash('sha256').update(bytes).digest('base64')
      insertMedia(db, { mediaId, ownerId: phone.id, mimeType, sha256, bytes, createdAt: now })
      payload = { image: { mime_type: mimeType, sha256, id: mediaId, ...(i.text ? { caption: i.text } : {}) } }
      renderedText = `[image] ${i.text ?? ''}`.trim()
    } else if (i.type === 'button') {
      payload = { button: { text: i.text ?? '', payload: i.text ?? '' } }
    } else {
      payload = { text: { body: i.text ?? '' } }
    }
    const msg: MessageRow = { wamid, phoneNumberId: phone.id, direction: 'in', peer, type: i.type, body: payload, renderedText, status: 'received', createdAt: now }
    insertMessage(db, msg)
    await bus.emit({
      kind: 'inbound',
      waba,
      phone,
      wamid,
      now,
      change: { field: 'messages', value: inboundValue(phone, { wamid, from: peer, name: i.name ?? 'Test Customer', type: i.type, payload, at: now }) },
    })
    bus.notify({ type: 'message', message: msg })
    return msg
  }

  scheduleTemplateApproval(t: TemplateRow): void {
    const seconds = this.d.config.templates.autoApproveSeconds
    if (seconds < 0) return
    this.d.clock.schedule(seconds * 1000, async () => {
      const current = getTemplateById(this.d.db, t.metaTemplateId)
      // Skip if the template was deleted, decided by hand, or edited again since this was scheduled.
      if (current?.status === 'PENDING' && current.updatedAt === t.updatedAt) {
        await this.setTemplateStatus(t.metaTemplateId, 'APPROVED')
      }
    })
  }

  async setTemplateStatus(metaTemplateId: string, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<TemplateRow> {
    const { db, clock, bus } = this.d
    const t = getTemplateById(db, metaTemplateId)
    const waba = t && getWaba(db, t.wabaId)
    if (!t || !waba) throw new Error(`unknown template ${metaTemplateId}`)
    const now = clock.now()
    setTemplateStatus(db, metaTemplateId, status, now)
    await bus.emit({ kind: 'template_status', waba, now, change: { field: 'message_template_status_update', value: templateStatusValue(t, status, reason) } })
    const updated = getTemplateById(db, metaTemplateId)!
    bus.notify({ type: 'template', template: updated })
    return updated
  }

  resumePendingTemplates(): void {
    for (const t of listPendingTemplates(this.d.db)) this.scheduleTemplateApproval(t)
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/simulator.ts test/sim/simulator.test.ts
git commit -m "feat: delivery, inbound and template-approval simulator"
```

---

### Task 8: Server and AWS API pipeline

**Files:**
- Create: `src/context.ts`, `src/aws/blobStore.ts`, `src/api/aws.ts`, `src/services/socialmessaging/index.ts`, `src/server.ts`, `test/helpers.ts`
- Test: `test/api/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces:
  - `context.ts`: `interface Ctx { config: Config; db: Db; clock: Clock; bus: EventBus; sim: Simulator; blobStore: BlobStore; model: SmithyModel }`, `type Handler = (input: any, ctx: Ctx) => unknown | Promise<unknown>`, `type HandlerMap = Record<string, Handler>`
  - `blobStore.ts`: `interface BlobStore { get(bucket: string, key: string): Promise<{ bytes: Uint8Array; contentType?: string }>; put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void> }`, `s3BlobStore(endpoint, region)`, `noBlobStore()`, `interface MemoryBlobStore extends BlobStore { objects: Map<string, { bytes: Uint8Array; contentType?: string }> }`, `memoryBlobStore(): MemoryBlobStore` (map key `${bucket}/${key}`)
  - `api/aws.ts`: `registerAwsApi(app: FastifyInstance, model: SmithyModel, handlers: HandlerMap, ctx: Ctx): void`, `coverage(model: SmithyModel, handlers: HandlerMap): { simulated: string[]; notSimulated: string[] }`
  - `services/socialmessaging/index.ts`: `socialMessagingHandlers(): HandlerMap` (initially `{}`; Tasks 9–12 spread their maps in)
  - `server.ts`: `interface AppOptions { config: Config; clock?: Clock; sinks?: Sink[]; blobStore?: BlobStore; logger?: boolean }`, `interface App { fastify: FastifyInstance; ctx: Ctx; model: SmithyModel; handlers: HandlerMap; close(): Promise<void> }`, `buildApp(opts: AppOptions): Promise<App>`
  - `test/helpers.ts`: `TEST_TOPIC`, `TEST_SEED`, `WABA_ID`, `PHONE_ID`, `interface Harness { app: App; url: string; client: SocialMessagingClient; clock: FakeClock; published: { arn: string; envelope: Envelope }[]; blobs: MemoryBlobStore; close(): Promise<void> }`, `startHarness(over?: Partial<Config>): Promise<Harness>`, `entry(e: Envelope): any`, `utf8(s: string): Uint8Array`, `signedFetch(url: string, init?: RequestInit): Promise<Response>` (adds a dummy SigV4 `authorization` header)

- [ ] **Step 1: Write the test helpers**

`test/helpers.ts`:
```ts
import { SocialMessagingClient } from '@aws-sdk/client-socialmessaging'
import { parseConfig, type Config, type WabaSeed } from '../src/config.ts'
import { phoneAwsId, wabaAwsId } from '../src/domain/ids.ts'
import { memoryBlobStore, type MemoryBlobStore } from '../src/aws/blobStore.ts'
import type { Envelope } from '../src/events/envelope.ts'
import type { Sink } from '../src/events/sinks.ts'
import { buildApp, type App } from '../src/server.ts'
import { FakeClock } from '../src/sim/clock.ts'

export const TEST_TOPIC = 'arn:aws:sns:ap-south-1:000000000000:eum-events'
export const TEST_SEED: WabaSeed = {
  name: 'Example Business',
  metaWabaId: '100000000000001',
  eventDestinations: [TEST_TOPIC],
  phoneNumbers: [{ phoneNumber: '+919800000001', displayName: 'Example Sender', metaPhoneNumberId: '200000000000001' }],
  templates: [
    { name: 'invoice_reminder', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, invoice {{2}} of {{3}} is due on {{4}}.' }] },
  ],
}
export const WABA_ID = wabaAwsId('100000000000001')
export const PHONE_ID = phoneAwsId('200000000000001')

export interface Harness {
  app: App
  url: string
  client: SocialMessagingClient
  clock: FakeClock
  published: { arn: string; envelope: Envelope }[]
  blobs: MemoryBlobStore
  close(): Promise<void>
}

export async function startHarness(over: Partial<Config> = {}): Promise<Harness> {
  const clock = new FakeClock()
  const published: { arn: string; envelope: Envelope }[] = []
  const sink: Sink = {
    name: 'capture',
    accepts: (arn) => arn.startsWith('arn:aws:sns:'),
    publish: async (arn, envelope) => {
      published.push({ arn, envelope })
      return `captured-${published.length}`
    },
  }
  const blobs = memoryBlobStore()
  const config: Config = { ...parseConfig(undefined, {}), dbPath: ':memory:', wabas: [TEST_SEED], ...over }
  const app = await buildApp({ config, clock, sinks: [sink], blobStore: blobs, logger: false })
  const url = await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const client = new SocialMessagingClient({
    endpoint: url,
    region: 'ap-south-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  })
  return {
    app, url, client, clock, published, blobs,
    close: async () => {
      client.destroy()
      await app.close()
    },
  }
}

export const entry = (e: Envelope): any => JSON.parse(e.whatsAppWebhookEntry)
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export const signedFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, headers: { authorization: 'AWS4-HMAC-SHA256 Credential=test/20261007/ap-south-1/social-messaging/aws4_request', ...init.headers } })
```

- [ ] **Step 2: Write the failing test**

`test/api/pipeline.test.ts`:
```ts
import { GetWhatsAppFlowCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signedFetch, startHarness, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })

describe('AWS API pipeline', () => {
  it('returns 501 InternalServiceException for operations without a handler', async () => {
    const err = await h.client.send(new GetWhatsAppFlowCommand({ id: 'waba-1', flowId: '123' })).catch((e) => e)
    expect(err.name).toBe('InternalServiceException')
    expect(err.message).toMatch(/GetWhatsAppFlow is not simulated yet/)
    expect(err.$metadata.httpStatusCode).toBe(501)
  })

  it('validates input through the real SDK', async () => {
    const err = await h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: 'bad-id', message: new Uint8Array([1]), metaApiVersion: 'v20.0' })).catch((e) => e)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toMatch(/originationPhoneNumberId.*regular expression/)
    expect(err.$metadata.httpStatusCode).toBe(400)
  })

  it('rejects unsigned requests', async () => {
    const res = await fetch(`${h.url}/v1/whatsapp/waba/list`)
    expect(res.status).toBe(403)
    expect(res.headers.get('x-amzn-errortype')).toBe('AccessDeniedException')
  })

  it('returns ValidationException for a non-JSON body (Review Focus 4)', async () => {
    const res = await signedFetch(`${h.url}/v1/whatsapp/send`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect(res.headers.get('x-amzn-errortype')).toBe('ValidationException')
    expect(await res.json()).toEqual({ message: 'Request body is not valid JSON' })
  })

  it('returns ValidationException for a mistyped query value (Review Focus 4)', async () => {
    const res = await signedFetch(`${h.url}/v1/whatsapp/waba/list?maxResults=abc`)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/maxResults.*integer/)
  })

  it('returns 404 for unknown routes and a request id on every response', async () => {
    const res = await signedFetch(`${h.url}/v1/whatsapp/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('x-amzn-requestid')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('serves health', async () => {
    expect(await (await fetch(`${h.url}/_eum/health`)).json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/pipeline.test.ts`
Expected: FAIL — `src/server.ts` not found.

- [ ] **Step 4: Implement context and blob stores**

`src/context.ts`:
```ts
import type { BlobStore } from './aws/blobStore.ts'
import type { Config } from './config.ts'
import type { EventBus } from './events/bus.ts'
import type { Clock } from './sim/clock.ts'
import type { Simulator } from './sim/simulator.ts'
import type { SmithyModel } from './smithy/model.ts'
import type { Db } from './store/db.ts'

export interface Ctx {
  config: Config
  db: Db
  clock: Clock
  bus: EventBus
  sim: Simulator
  blobStore: BlobStore
  model: SmithyModel
}

// Input is already bound and validated against the operation's input shape.
export type Handler = (input: any, ctx: Ctx) => unknown | Promise<unknown>
export type HandlerMap = Record<string, Handler>
```

`src/aws/blobStore.ts`:
```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface BlobStore {
  get(bucket: string, key: string): Promise<{ bytes: Uint8Array; contentType?: string }>
  put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>
}

export function s3BlobStore(endpoint: string, region: string): BlobStore {
  const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 })
  return {
    async get(bucket, key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      return { bytes: await out.Body!.transformToByteArray(), contentType: out.ContentType }
    },
    async put(bucket, key, bytes, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }))
    },
  }
}

export function noBlobStore(): BlobStore {
  const unavailable = async (): Promise<never> => {
    throw new Error('S3 is unavailable because no aws.endpoint is configured')
  }
  return { get: unavailable, put: unavailable }
}

export interface MemoryBlobStore extends BlobStore {
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>
}

export function memoryBlobStore(): MemoryBlobStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  return {
    objects,
    async get(bucket, key) {
      const o = objects.get(`${bucket}/${key}`)
      if (!o) throw new Error(`NoSuchKey: ${bucket}/${key}`)
      return o
    },
    async put(bucket, key, bytes, contentType) {
      objects.set(`${bucket}/${key}`, { bytes, contentType })
    },
  }
}
```

- [ ] **Step 5: Implement the AWS API pipeline**

`src/api/aws.ts`:
```ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ctx, HandlerMap } from '../context.ts'
import { bindInput, toJson } from '../smithy/bind.ts'
import { AwsError } from '../smithy/errors.ts'
import type { SmithyModel } from '../smithy/model.ts'
import { buildRouter } from '../smithy/router.ts'
import { validate, validationMessage } from '../smithy/validate.ts'

const sendError = (reply: FastifyReply, status: number, type: string, message: string) =>
  reply.code(status).header('x-amzn-errortype', type).type('application/json').send(JSON.stringify({ message }))

export function coverage(model: SmithyModel, handlers: HandlerMap): { simulated: string[]; notSimulated: string[] } {
  const names = [...model.operations.keys()].sort()
  return { simulated: names.filter((n) => handlers[n]), notSimulated: names.filter((n) => !handlers[n]) }
}

export function registerAwsApi(app: FastifyInstance, model: SmithyModel, handlers: HandlerMap, ctx: Ctx): void {
  const router = buildRouter(model)
  // Encapsulated so the raw-buffer body parser does not affect the admin API.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    scope.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      url: '/v1/*',
      handler: async (req, reply) => {
        reply.header('x-amzn-requestid', randomUUID())
        const url = new URL(req.url, 'http://local')
        const op = router.match(req.method, url.pathname)
        if (!op) return sendError(reply, 404, 'UnknownOperationException', `eum-social-local-emulator: no operation for ${req.method} ${url.pathname}`)
        if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256')) {
          return sendError(reply, 403, 'AccessDeniedException', 'Missing Authentication Token: requests must be signed with AWS SigV4')
        }
        let body: unknown = {}
        const raw = req.body as Buffer | undefined
        if (raw && raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'))
          } catch {
            return sendError(reply, 400, 'ValidationException', 'Request body is not valid JSON')
          }
        }
        const input = bindInput(model, op, url.searchParams, body)
        const violations = validate(model, op.input, input)
        if (violations.length) return sendError(reply, 400, 'ValidationException', validationMessage(violations))
        const handler = handlers[op.name]
        if (!handler) return sendError(reply, 501, 'InternalServiceException', `eum-social-local-emulator: ${op.name} is not simulated yet`)
        try {
          const out = await handler(input, ctx)
          return reply.code(200).type('application/json').send(JSON.stringify(toJson(model, op.output, out) ?? {}))
        } catch (err) {
          if (err instanceof AwsError && op.errors.includes(err.type)) {
            return sendError(reply, err.status ?? model.errorStatus(err.type), err.type, err.message)
          }
          req.log.error({ err, operation: op.name }, 'eum-social-local-emulator: handler failed')
          const message = err instanceof AwsError
            ? `eum-social-local-emulator bug: ${op.name} raised undeclared ${err.type}: ${err.message}`
            : 'eum-social-local-emulator internal error; see the server log'
          return sendError(reply, 500, 'InternalServiceException', message)
        }
      },
    })
  })
}
```

`src/services/socialmessaging/index.ts`:
```ts
import type { HandlerMap } from '../../context.ts'

// Each simulated area contributes its handlers here; operations without one return 501.
export function socialMessagingHandlers(): HandlerMap {
  return {}
}
```

- [ ] **Step 6: Implement the server**

`src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { noBlobStore, s3BlobStore, type BlobStore } from './aws/blobStore.ts'
import { registerAwsApi } from './api/aws.ts'
import type { Config } from './config.ts'
import type { Ctx, HandlerMap } from './context.ts'
import { EventBus } from './events/bus.ts'
import { snsSink, type Sink } from './events/sinks.ts'
import { socialMessagingHandlers } from './services/socialmessaging/index.ts'
import { RealClock, type Clock } from './sim/clock.ts'
import { Simulator } from './sim/simulator.ts'
import { MODEL_PATH, SmithyModel } from './smithy/model.ts'
import { openDb } from './store/db.ts'
import { seedFromConfig } from './store/seed.ts'

export interface AppOptions {
  config: Config
  clock?: Clock
  sinks?: Sink[]
  blobStore?: BlobStore
  logger?: boolean
}

export interface App {
  fastify: FastifyInstance
  ctx: Ctx
  model: SmithyModel
  handlers: HandlerMap
  close(): Promise<void>
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const { config } = opts
  const fastify = Fastify({ logger: opts.logger ?? true, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true })
  const model = SmithyModel.load(MODEL_PATH)
  const db = openDb(config.dbPath)
  const clock = opts.clock ?? new RealClock()
  seedFromConfig(db, config, clock.now())
  const sinks = opts.sinks ?? (config.aws ? [snsSink(config.aws.endpoint, config.region)] : [])
  const bus = new EventBus({ db, sinks, accountId: config.accountId, webhookUrl: config.webhookUrl, log: fastify.log })
  const sim = new Simulator({ db, clock, bus, config })
  const blobStore = opts.blobStore ?? (config.aws ? s3BlobStore(config.aws.endpoint, config.region) : noBlobStore())
  const ctx: Ctx = { config, db, clock, bus, sim, blobStore, model }
  const handlers = socialMessagingHandlers()

  registerAwsApi(fastify, model, handlers, ctx)
  fastify.get('/_eum/health', async () => ({ status: 'ok' }))
  sim.resumePendingTemplates()

  return {
    fastify,
    ctx,
    model,
    handlers,
    close: async () => {
      clock.cancelAll()
      await fastify.close()
      db.close()
    },
  }
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/context.ts src/aws src/api/aws.ts src/services src/server.ts test/helpers.ts test/api/pipeline.test.ts
git commit -m "feat: Fastify server with model-driven AWS API pipeline"
```

---

### Task 9: WABA, phone-number, event-destination and tag operations

**Files:**
- Create: `src/services/socialmessaging/waba.ts`, `src/services/socialmessaging/tags.ts`
- Modify: `src/services/socialmessaging/index.ts`
- Test: `test/api/waba.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `HandlerMap` (Task 8), store repos, `createWaba` (Task 4), `paginate`, `resolveId`, `metaNumericId` (Task 4), `AwsError`, `invalid`, `notFound` (Task 3)
- Produces:
  - `phoneDetail(p: PhoneRow)` (output shape `WhatsAppPhoneNumberDetail`)
  - `requireWaba(ctx: Ctx, idOrArn: string, missing?: 'ResourceNotFoundException' | 'InvalidParametersException'): WabaRow`
  - `requirePhone(ctx: Ctx, idOrArn: string): { phone: PhoneRow; waba: WabaRow }` — throws `ResourceNotFoundException`
  - `wabaHandlers: HandlerMap` (6 WABA/phone ops + `PutWhatsAppBusinessAccountEventDestinations`), `tagHandlers: HandlerMap` (3 ops)

- [ ] **Step 1: Write the failing test**

`test/api/waba.test.ts`:
```ts
import {
  AssociateWhatsAppBusinessAccountCommand, DisassociateWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountCommand,
  GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, ListLinkedWhatsAppBusinessAccountsCommand, ListTagsForResourceCommand,
  PutWhatsAppBusinessAccountEventDestinationsCommand, TagResourceCommand, UntagResourceCommand, UpdateLinkedWhatsAppBusinessAccountPhoneNumberCommand,
} from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMessage, insertMessage } from '../../src/store/messages.ts'
import { PHONE_ID, startHarness, TEST_TOPIC, WABA_ID, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })

describe('WABA operations', () => {
  it('lists and gets the seeded WABA with its phone numbers', async () => {
    const list = await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({}))
    expect(list.linkedAccounts).toHaveLength(1)
    expect(list.linkedAccounts![0]).toMatchObject({ id: WABA_ID, wabaId: '100000000000001', registrationStatus: 'COMPLETE', wabaName: 'Example Business', eventDestinations: [{ eventDestinationArn: TEST_TOPIC }] })
    expect(list.linkedAccounts![0].linkDate).toBeInstanceOf(Date)

    const got = await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: list.linkedAccounts![0].arn! }))
    expect(got.account?.phoneNumbers).toEqual([expect.objectContaining({ phoneNumberId: PHONE_ID, phoneNumber: '+919800000001', metaPhoneNumberId: '200000000000001', qualityRating: 'GREEN' })])
  })

  it('paginates the account list', async () => {
    const page = await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({ maxResults: 1 }))
    expect(page.linkedAccounts).toHaveLength(1)
    expect(page.nextToken).toBeUndefined()
  })

  it('gets and updates a phone number', async () => {
    const got = await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))
    expect(got).toMatchObject({ linkedWhatsAppBusinessAccountId: WABA_ID, phoneNumber: { displayPhoneNumberName: 'Example Sender' } })
    const upd = await h.client.send(new UpdateLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID, callSettings: { callEnabled: true } }))
    expect(upd.phoneNumberId).toBe(PHONE_ID)
    expect((await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))).callSettings).toEqual({ callEnabled: true })
  })

  it('returns ResourceNotFoundException for unknown ids', async () => {
    const err = await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: 'waba-doesnotexist' })).catch((e) => e)
    expect(err.name).toBe('ResourceNotFoundException')
  })

  it('replaces event destinations; unknown WABA is InvalidParametersException', async () => {
    const arn = 'arn:aws:sns:ap-south-1:000000000000:other'
    await h.client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id: WABA_ID, eventDestinations: [{ eventDestinationArn: arn }] }))
    expect((await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: WABA_ID }))).account?.eventDestinations).toEqual([{ eventDestinationArn: arn }])
    const err = await h.client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id: 'waba-x', eventDestinations: [] })).catch((e) => e)
    expect(err.name).toBe('InvalidParametersException')
  })

  it('runs the two-step signup: callback then finalization', async () => {
    const cb = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({ signupCallback: { accessToken: 'meta-token' } }))
    const token = cb.signupCallbackResult!.associateInProgressToken!
    const [metaWabaId, pending] = Object.entries(cb.signupCallbackResult!.linkedAccountsWithIncompleteSetup!)[0]
    expect(pending.registrationStatus).toBe('INCOMPLETE')
    const phone = pending.unregisteredWhatsAppPhoneNumbers![0]

    const fin = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({
      setupFinalization: { associateInProgressToken: token, phoneNumbers: [{ id: phone.metaPhoneNumberId!, twoFactorPin: '123456' }], waba: { id: metaWabaId, eventDestinations: [{ eventDestinationArn: TEST_TOPIC }] } },
    }))
    expect(fin.linkedWhatsAppBusinessAccountId).toBe(pending.wabaId)
    const got = await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: fin.linkedWhatsAppBusinessAccountId! }))
    expect(got.account?.registrationStatus).toBe('COMPLETE')

    const again = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({ setupFinalization: { associateInProgressToken: token, phoneNumbers: [] } })).catch((e) => e)
    expect(again.name).toBe('InvalidParametersException')
  })

  it('disassociates a WABA, dropping its phones and messages (Review Focus 2)', async () => {
    insertMessage(h.app.ctx.db, { wamid: 'w1', phoneNumberId: PHONE_ID, direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 0 })
    await h.client.send(new DisassociateWhatsAppBusinessAccountCommand({ id: WABA_ID }))
    expect((await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({}))).linkedAccounts).toEqual([])
    expect(getMessage(h.app.ctx.db, 'w1')).toBeUndefined()
    await expect(h.app.ctx.sim.applyStatus('w1', 'sent')).resolves.toBeUndefined()
  })
})

describe('tag operations', () => {
  it('tags, lists and untags a WABA ARN', async () => {
    const arn = (await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: WABA_ID }))).account!.arn!
    await h.client.send(new TagResourceCommand({ resourceArn: arn, tags: [{ key: 'env', value: 'dev' }, { key: 'team', value: 'ar' }] }))
    await h.client.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: ['team'] }))
    expect((await h.client.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags).toEqual([{ key: 'env', value: 'dev' }])
  })

  it('rejects unknown ARNs with InvalidParametersException', async () => {
    const err = await h.client.send(new ListTagsForResourceCommand({ resourceArn: 'arn:aws:social-messaging:ap-south-1:000000000000:waba/nope' })).catch((e) => e)
    expect(err.name).toBe('InvalidParametersException')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/waba.test.ts`
Expected: FAIL — every call returns `InternalServiceException` (not simulated).

- [ ] **Step 3: Implement WABA handlers**

`src/services/socialmessaging/waba.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId, resolveId } from '../../domain/ids.ts'
import { paginate } from '../../domain/paging.ts'
import { AwsError, invalid, notFound } from '../../smithy/errors.ts'
import { createWaba } from '../../store/seed.ts'
import { deleteTagsFor, putTags } from '../../store/tags.ts'
import type { PhoneRow, WabaRow } from '../../store/types.ts'
import { deleteWaba, getPhone, getWaba, getWabaByToken, listPhones, listWabas, updatePhoneCallSettings, updateWaba } from '../../store/wabas.ts'

export const phoneDetail = (p: PhoneRow) => ({
  arn: p.arn,
  phoneNumber: p.phoneNumber,
  phoneNumberId: p.id,
  metaPhoneNumberId: p.metaPhoneNumberId,
  displayPhoneNumberName: p.displayName,
  displayPhoneNumber: p.displayPhoneNumber,
  qualityRating: p.qualityRating,
  dataLocalizationRegion: p.dataLocalizationRegion,
})

const wabaSummary = (w: WabaRow) => ({
  arn: w.arn,
  id: w.id,
  wabaId: w.metaWabaId,
  registrationStatus: w.registrationStatus,
  linkDate: new Date(w.linkDate),
  wabaName: w.name,
  eventDestinations: w.eventDestinations,
})

export function requireWaba(ctx: Ctx, idOrArn: string, missing: 'ResourceNotFoundException' | 'InvalidParametersException' = 'ResourceNotFoundException'): WabaRow {
  const waba = getWaba(ctx.db, resolveId(idOrArn, 'waba'))
  if (!waba) throw new AwsError(missing, `WhatsApp Business Account ${idOrArn} not found`)
  return waba
}

export function requirePhone(ctx: Ctx, idOrArn: string): { phone: PhoneRow; waba: WabaRow } {
  const phone = getPhone(ctx.db, resolveId(idOrArn, 'phone-number-id'))
  const waba = phone && getWaba(ctx.db, phone.wabaId)
  if (!phone || !waba) throw notFound(`Phone number ${idOrArn}`)
  return { phone, waba }
}

export const wabaHandlers: HandlerMap = {
  // Real AWS only allows this from the console; eum-social-local-emulator accepts it so tests can create WABAs.
  AssociateWhatsAppBusinessAccount(input, ctx) {
    if (input.signupCallback) {
      const metaWabaId = metaNumericId()
      const waba = createWaba(
        ctx.db,
        ctx.config,
        { name: `Signup ${metaWabaId}`, metaWabaId, phoneNumbers: [{ phoneNumber: `+1555${metaWabaId.slice(-7)}`, displayName: 'Signup Test Number', metaPhoneNumberId: metaNumericId() }] },
        ctx.clock.now(),
        'INCOMPLETE',
      )
      const token = randomBytes(16).toString('hex')
      updateWaba(ctx.db, { ...waba, associateToken: token })
      ctx.bus.notify({ type: 'waba' })
      return {
        statusCode: 200,
        signupCallbackResult: {
          associateInProgressToken: token,
          linkedAccountsWithIncompleteSetup: {
            [metaWabaId]: { accountName: waba.name, registrationStatus: 'INCOMPLETE', unregisteredWhatsAppPhoneNumbers: listPhones(ctx.db, waba.id).map(phoneDetail), wabaId: waba.id },
          },
        },
      }
    }
    if (input.setupFinalization) {
      const f = input.setupFinalization
      const waba = getWabaByToken(ctx.db, f.associateInProgressToken)
      if (!waba) throw invalid('associateInProgressToken is unknown or already used')
      if (f.waba?.id && f.waba.id !== waba.metaWabaId) throw invalid(`waba.id ${f.waba.id} does not match the signup in progress`)
      const phones = listPhones(ctx.db, waba.id)
      for (const p of f.phoneNumbers) {
        const phone = phones.find((x) => x.metaPhoneNumberId === p.id)
        if (!phone) throw invalid(`Phone number ${p.id} is not part of this signup`)
        if (p.tags) putTags(ctx.db, phone.arn, p.tags)
      }
      updateWaba(ctx.db, { ...waba, registrationStatus: 'COMPLETE', associateToken: undefined, eventDestinations: f.waba?.eventDestinations ?? waba.eventDestinations })
      if (f.waba?.tags) putTags(ctx.db, waba.arn, f.waba.tags)
      ctx.bus.notify({ type: 'waba' })
      return { statusCode: 200, linkedWhatsAppBusinessAccountId: waba.id }
    }
    throw invalid('Provide signupCallback or setupFinalization')
  },

  DisassociateWhatsAppBusinessAccount(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    deleteTagsFor(ctx.db, [waba.arn, ...listPhones(ctx.db, waba.id).map((p) => p.arn)])
    deleteWaba(ctx.db, waba.id)
    ctx.bus.notify({ type: 'waba' })
    return {}
  },

  GetLinkedWhatsAppBusinessAccount(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    return { account: { ...wabaSummary(waba), phoneNumbers: listPhones(ctx.db, waba.id).map(phoneDetail) } }
  },

  ListLinkedWhatsAppBusinessAccounts(input, ctx) {
    const page = paginate(listWabas(ctx.db).map(wabaSummary), input.nextToken, input.maxResults)
    return { linkedAccounts: page.items, nextToken: page.nextToken }
  },

  GetLinkedWhatsAppBusinessAccountPhoneNumber(input, ctx) {
    const { phone, waba } = requirePhone(ctx, input.id)
    return { phoneNumber: phoneDetail(phone), linkedWhatsAppBusinessAccountId: waba.id, callSettings: phone.callSettings }
  },

  UpdateLinkedWhatsAppBusinessAccountPhoneNumber(input, ctx) {
    const { phone } = requirePhone(ctx, input.id)
    updatePhoneCallSettings(ctx.db, phone.id, input.callSettings)
    return { phoneNumberId: phone.id }
  },

  PutWhatsAppBusinessAccountEventDestinations(input, ctx) {
    const waba = requireWaba(ctx, input.id, 'InvalidParametersException')
    updateWaba(ctx.db, { ...waba, eventDestinations: input.eventDestinations })
    ctx.bus.notify({ type: 'waba' })
    return {}
  },
}
```

- [ ] **Step 4: Implement tag handlers**

`src/services/socialmessaging/tags.ts`:
```ts
import type { Ctx, HandlerMap } from '../../context.ts'
import { invalid } from '../../smithy/errors.ts'
import { listTags, putTags, removeTags } from '../../store/tags.ts'
import { listPhones, listWabas } from '../../store/wabas.ts'

// The tagging operations do not declare ResourceNotFoundException, so unknown ARNs are invalid parameters.
function requireTaggable(ctx: Ctx, arn: string): void {
  const known = listWabas(ctx.db).flatMap((w) => [w.arn, ...listPhones(ctx.db, w.id).map((p) => p.arn)])
  if (!known.includes(arn)) throw invalid(`Resource ${arn} not found`)
}

export const tagHandlers: HandlerMap = {
  TagResource(input, ctx) {
    requireTaggable(ctx, input.resourceArn)
    putTags(ctx.db, input.resourceArn, input.tags)
    return { statusCode: 200 }
  },
  UntagResource(input, ctx) {
    requireTaggable(ctx, input.resourceArn)
    removeTags(ctx.db, input.resourceArn, input.tagKeys)
    return { statusCode: 200 }
  },
  ListTagsForResource(input, ctx) {
    requireTaggable(ctx, input.resourceArn)
    return { statusCode: 200, tags: listTags(ctx.db, input.resourceArn) }
  },
}
```

- [ ] **Step 5: Register the handlers**

`src/services/socialmessaging/index.ts` (replace):
```ts
import type { HandlerMap } from '../../context.ts'
import { tagHandlers } from './tags.ts'
import { wabaHandlers } from './waba.ts'

// Each simulated area contributes its handlers here; operations without one return 501.
export function socialMessagingHandlers(): HandlerMap {
  return { ...wabaHandlers, ...tagHandlers }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/socialmessaging test/api/waba.test.ts
git commit -m "feat: WABA, phone number, event destination and tag operations"
```

---

### Task 10: Template operations

**Files:**
- Create: `src/services/socialmessaging/templates.ts`, `src/services/socialmessaging/library.ts`, `src/services/socialmessaging/s3io.ts`
- Modify: `src/services/socialmessaging/index.ts`
- Test: `test/api/templates.test.ts`

**Interfaces:**
- Consumes: `requireWaba` (Task 9), template repos (Task 4), `validateTemplateName` (Task 6), `paginate`, `metaNumericId` (Task 4), `ctx.sim.scheduleTemplateApproval` (Task 7), `insertMedia` (Task 4), `ctx.blobStore` (Task 8)
- Produces:
  - `LIBRARY: LibraryEntry[]`, `interface LibraryEntry { templateName: string; templateLanguage: string; templateCategory: string; templateTopic: string; templateUseCase: string; templateIndustry: string[]; templateHeader?: string; templateBody: string; templateBodyExampleParams: string[]; templateButtons?: { type: string; text: string; url?: string }[]; templateId: string }`, `libraryComponents(e: LibraryEntry): TemplateComponent[]`
  - `s3io.ts`: `readS3(ctx: Ctx, f: { bucketName: string; key: string }): Promise<{ bytes: Uint8Array; mimeType: string }>`, `writeS3(ctx, f, bytes, mimeType): Promise<void>`, `guessMime(name: string): string` — all failures become `InvalidParametersException`
  - `templateHandlers: HandlerMap` (8 ops)

- [ ] **Step 1: Write the failing test**

`test/api/templates.test.ts`:
```ts
import {
  CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateFromLibraryCommand, CreateWhatsAppMessageTemplateMediaCommand,
  DeleteWhatsAppMessageTemplateCommand, GetWhatsAppMessageTemplateCommand, ListWhatsAppMessageTemplatesCommand,
  ListWhatsAppTemplateLibraryCommand, UpdateWhatsAppMessageTemplateCommand,
} from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entry, startHarness, utf8, WABA_ID, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness({ templates: { autoApproveSeconds: 10 } }) })
afterEach(async () => { await h.close() })

const def = (over: Record<string, unknown> = {}) => utf8(JSON.stringify({
  name: 'payment_received', language: 'en_US', category: 'UTILITY',
  components: [{ type: 'BODY', text: 'We received {{1}} for invoice {{2}}.' }], ...over,
}))

describe('template operations', () => {
  it('creates a PENDING template that auto-approves and emits a status event', async () => {
    const out = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def() }))
    expect(out).toMatchObject({ templateStatus: 'PENDING', category: 'UTILITY', metaTemplateId: expect.stringMatching(/^\d+$/) })
    await h.clock.advance(10_000)
    const got = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: out.metaTemplateId }))
    expect(JSON.parse(got.template!)).toMatchObject({ name: 'payment_received', status: 'APPROVED', language: 'en_US' })
    expect(entry(h.published.at(-1)!.envelope).changes[0]).toMatchObject({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'payment_received' } })
  })

  it('rejects bad names, bad JSON and duplicates with InvalidParametersException', async () => {
    const bad = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'Bad Name' }) })).catch((e) => e)
    expect(bad.name).toBe('InvalidParametersException')
    const notJson = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: utf8('{') })).catch((e) => e)
    expect(notJson.message).toMatch(/templateDefinition is not valid JSON/)
    const dup = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'invoice_reminder', language: 'en' }) })).catch((e) => e)
    expect(dup.message).toMatch(/already exists/)
  })

  it('allows the same name in another language', async () => {
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'invoice_reminder', language: 'hi' }) }))).resolves.toBeDefined()
  })

  it('lists, gets by name+language, updates back to PENDING and deletes', async () => {
    const list = await h.client.send(new ListWhatsAppMessageTemplatesCommand({ id: WABA_ID }))
    expect(list.templates).toEqual([expect.objectContaining({ templateName: 'invoice_reminder', templateStatus: 'APPROVED', templateLanguage: 'en', templateCategory: 'UTILITY' })])

    const byName = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder', templateLanguageCode: 'en' }))
    const id = JSON.parse(byName.template!).id

    await h.client.send(new UpdateWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id, templateComponents: utf8(JSON.stringify([{ type: 'BODY', text: 'Hi {{1}}' }])) }))
    const after = JSON.parse((await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id }))).template!)
    expect(after).toMatchObject({ status: 'PENDING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] })

    await h.client.send(new DeleteWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder' }))
    const gone = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id })).catch((e) => e)
    expect(gone.name).toBe('ResourceNotFoundException')
  })

  it('requires an id or name+language to get a template', async () => {
    const err = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder' })).catch((e) => e)
    expect(err.name).toBe('InvalidParametersException')
  })

  it('lists the library with filters and creates from it', async () => {
    const lib = await h.client.send(new ListWhatsAppTemplateLibraryCommand({ id: WABA_ID, filters: { searchKey: 'payment' } }))
    expect(lib.metaLibraryTemplates!.length).toBeGreaterThan(0)
    const pick = lib.metaLibraryTemplates![0]
    const out = await h.client.send(new CreateWhatsAppMessageTemplateFromLibraryCommand({
      id: WABA_ID,
      metaLibraryTemplate: { templateName: 'my_payment', libraryTemplateName: pick.templateName!, templateCategory: 'UTILITY', templateLanguage: 'en_US' },
    }))
    expect(out.templateStatus).toBe('PENDING')
    const missing = await h.client.send(new CreateWhatsAppMessageTemplateFromLibraryCommand({
      id: WABA_ID, metaLibraryTemplate: { templateName: 'x', libraryTemplateName: 'nope', templateCategory: 'UTILITY', templateLanguage: 'en_US' },
    })).catch((e) => e)
    expect(missing.name).toBe('InvalidParametersException')
  })

  it('uploads template header media from S3', async () => {
    await h.blobs.put('media', 'logo.png', utf8('png-bytes'), 'image/png')
    const out = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'logo.png' } }))
    expect(out.metaHeaderHandle).toMatch(/^4::/)
    const missing = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'nope.png' } })).catch((e) => e)
    expect(missing.name).toBe('InvalidParametersException')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/templates.test.ts`
Expected: FAIL — template operations return 501.

- [ ] **Step 3: Implement S3 I/O helpers**

`src/services/socialmessaging/s3io.ts`:
```ts
import type { Ctx } from '../../context.ts'
import { invalid } from '../../smithy/errors.ts'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', mp4: 'video/mp4', '3gp': 'video/3gpp', mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac',
  txt: 'text/plain', csv: 'text/csv', doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export const guessMime = (name: string): string => MIME[name.split('?')[0].split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function readS3(ctx: Ctx, f: { bucketName: string; key: string }): Promise<{ bytes: Uint8Array; mimeType: string }> {
  try {
    const o = await ctx.blobStore.get(f.bucketName, f.key)
    return { bytes: o.bytes, mimeType: o.contentType ?? guessMime(f.key) }
  } catch (err) {
    throw invalid(`Could not read s3://${f.bucketName}/${f.key}: ${reason(err)}`)
  }
}

export async function writeS3(ctx: Ctx, f: { bucketName: string; key: string }, bytes: Uint8Array, mimeType: string): Promise<void> {
  try {
    await ctx.blobStore.put(f.bucketName, f.key, bytes, mimeType)
  } catch (err) {
    throw invalid(`Could not write s3://${f.bucketName}/${f.key}: ${reason(err)}`)
  }
}
```

- [ ] **Step 4: Implement the template library**

`src/services/socialmessaging/library.ts`:
```ts
import type { TemplateComponent } from '../../store/types.ts'

export interface LibraryEntry {
  templateName: string
  templateLanguage: string
  templateCategory: string
  templateTopic: string
  templateUseCase: string
  templateIndustry: string[]
  templateHeader?: string
  templateBody: string
  templateBodyExampleParams: string[]
  templateButtons?: { type: string; text: string; url?: string }[]
  templateId: string
}

// A small, fixed stand-in for Meta's utility template library.
export const LIBRARY: LibraryEntry[] = [
  {
    templateName: 'payment_reminder_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'PAYMENT_REMINDER',
    templateIndustry: ['E_COMMERCE', 'FINANCIAL_SERVICES'], templateHeader: 'Payment reminder',
    templateBody: 'Hi {{1}}, this is a reminder that your payment of {{2}} for invoice {{3}} is due on {{4}}.',
    templateBodyExampleParams: ['Asha', '₹12,000', 'INV-1042', '9 Oct'], templateId: '100000000000101',
  },
  {
    templateName: 'payment_received_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'RECEIPT',
    templateIndustry: ['E_COMMERCE', 'FINANCIAL_SERVICES'],
    templateBody: 'Hi {{1}}, we have received your payment of {{2}} for invoice {{3}}. Thank you!',
    templateBodyExampleParams: ['Asha', '₹12,000', 'INV-1042'], templateId: '100000000000102',
  },
  {
    templateName: 'payment_overdue_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'PAYMENT_OVERDUE',
    templateIndustry: ['FINANCIAL_SERVICES'],
    templateBody: 'Hi {{1}}, invoice {{2}} for {{3}} is now {{4}} days overdue. Please pay at your earliest convenience.',
    templateBodyExampleParams: ['Asha', 'INV-1042', '₹12,000', '7'],
    templateButtons: [{ type: 'URL', text: 'Pay now', url: 'https://example.com/pay/{{1}}' }], templateId: '100000000000103',
  },
  {
    templateName: 'invoice_available_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'INVOICES', templateUseCase: 'INVOICE',
    templateIndustry: ['E_COMMERCE'],
    templateBody: 'Hi {{1}}, your invoice {{2}} for {{3}} is ready.',
    templateBodyExampleParams: ['Asha', 'INV-1042', '₹12,000'], templateId: '100000000000104',
  },
  {
    templateName: 'account_update_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'ACCOUNT', templateUseCase: 'ACCOUNT_UPDATE',
    templateIndustry: ['FINANCIAL_SERVICES'],
    templateBody: 'Hi {{1}}, your account details were updated on {{2}}. If this was not you, contact us.',
    templateBodyExampleParams: ['Asha', '7 Oct'], templateId: '100000000000105',
  },
  {
    templateName: 'statement_ready_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'ACCOUNT', templateUseCase: 'STATEMENT',
    templateIndustry: ['FINANCIAL_SERVICES'],
    templateBody: 'Hi {{1}}, your statement for {{2}} is ready to view.',
    templateBodyExampleParams: ['Asha', 'September'], templateId: '100000000000106',
  },
]

export function libraryComponents(e: LibraryEntry): TemplateComponent[] {
  const components: TemplateComponent[] = []
  if (e.templateHeader) components.push({ type: 'HEADER', format: 'TEXT', text: e.templateHeader })
  components.push({ type: 'BODY', text: e.templateBody, example: { body_text: [e.templateBodyExampleParams] } })
  if (e.templateButtons) components.push({ type: 'BUTTONS', buttons: e.templateButtons })
  return components
}
```

- [ ] **Step 5: Implement template handlers**

`src/services/socialmessaging/templates.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId } from '../../domain/ids.ts'
import { paginate } from '../../domain/paging.ts'
import { validateTemplateName } from '../../domain/templates.ts'
import { invalid, notFound } from '../../smithy/errors.ts'
import { insertMedia } from '../../store/media.ts'
import { deleteTemplate, findTemplate, getTemplateById, insertTemplate, listTemplates, listTemplatesByName, updateTemplate } from '../../store/templates.ts'
import type { TemplateComponent, TemplateRow, WabaRow } from '../../store/types.ts'
import { LIBRARY, libraryComponents } from './library.ts'
import { readS3 } from './s3io.ts'
import { requireWaba } from './waba.ts'

function parseBlobJson(blob: Uint8Array, what: string): any {
  try {
    return JSON.parse(Buffer.from(blob).toString('utf8'))
  } catch {
    throw invalid(`${what} is not valid JSON`)
  }
}

const metaTemplate = (t: TemplateRow) => ({
  name: t.name,
  language: t.language,
  category: t.category,
  status: t.status,
  id: t.metaTemplateId,
  parameter_format: t.parameterFormat,
  components: t.components,
})

function newTemplate(ctx: Ctx, waba: WabaRow, d: { name: unknown; language: unknown; category: unknown; components: unknown; parameterFormat?: unknown }): TemplateRow {
  const nameError = validateTemplateName(d.name)
  if (nameError) throw invalid(nameError)
  if (typeof d.language !== 'string' || !d.language) throw invalid('language is required')
  if (typeof d.category !== 'string' || !d.category) throw invalid('category is required')
  if (!Array.isArray(d.components)) throw invalid('components must be an array')
  const name = d.name as string
  if (findTemplate(ctx.db, waba.id, name, d.language)) throw invalid(`Template ${name} (${d.language}) already exists`)
  const now = ctx.clock.now()
  const t: TemplateRow = {
    metaTemplateId: metaNumericId(),
    wabaId: waba.id,
    name,
    language: d.language,
    category: d.category.toUpperCase(),
    status: 'PENDING',
    parameterFormat: String(d.parameterFormat ?? 'POSITIONAL').toUpperCase(),
    components: d.components as TemplateComponent[],
    createdAt: now,
    updatedAt: now,
  }
  insertTemplate(ctx.db, t)
  ctx.sim.scheduleTemplateApproval(t)
  ctx.bus.notify({ type: 'template', template: t })
  return t
}

function findOne(ctx: Ctx, waba: WabaRow, input: { metaTemplateId?: string; templateName?: string; templateLanguageCode?: string }): TemplateRow {
  let t: TemplateRow | undefined
  if (input.metaTemplateId) t = getTemplateById(ctx.db, input.metaTemplateId)
  else if (input.templateName && input.templateLanguageCode) t = findTemplate(ctx.db, waba.id, input.templateName, input.templateLanguageCode)
  else throw invalid('Provide metaTemplateId, or templateName and templateLanguageCode')
  if (!t || t.wabaId !== waba.id) throw notFound('Template')
  return t
}

const created = (t: TemplateRow) => ({ metaTemplateId: t.metaTemplateId, templateStatus: t.status, category: t.category })

export const templateHandlers: HandlerMap = {
  CreateWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const d = parseBlobJson(input.templateDefinition, 'templateDefinition')
    return created(newTemplate(ctx, waba, { name: d?.name, language: d?.language, category: d?.category, components: d?.components, parameterFormat: d?.parameter_format }))
  },

  CreateWhatsAppMessageTemplateFromLibrary(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const lib = input.metaLibraryTemplate
    const e = LIBRARY.find((x) => x.templateName === lib.libraryTemplateName)
    if (!e) throw invalid(`Library template ${lib.libraryTemplateName} not found`)
    return created(newTemplate(ctx, waba, { name: lib.templateName, language: lib.templateLanguage, category: lib.templateCategory, components: libraryComponents(e) }))
  },

  GetWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    return { template: JSON.stringify(metaTemplate(findOne(ctx, waba, input))) }
  },

  ListWhatsAppMessageTemplates(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const page = paginate(
      listTemplates(ctx.db, waba.id).map((t) => ({
        templateName: t.name,
        metaTemplateId: t.metaTemplateId,
        templateStatus: t.status,
        templateQualityScore: 'UNKNOWN',
        templateLanguage: t.language,
        templateCategory: t.category,
      })),
      input.nextToken,
      input.maxResults,
    )
    return { templates: page.items, nextToken: page.nextToken }
  },

  UpdateWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const t = findOne(ctx, waba, input)
    const components = input.templateComponents ? parseBlobJson(input.templateComponents, 'templateComponents') : t.components
    if (!Array.isArray(components)) throw invalid('templateComponents must be a JSON array')
    // Meta re-reviews every edit.
    const updated: TemplateRow = {
      ...t,
      category: input.templateCategory?.toUpperCase() ?? t.category,
      parameterFormat: input.parameterFormat?.toUpperCase() ?? t.parameterFormat,
      components,
      status: 'PENDING',
      updatedAt: ctx.clock.now(),
    }
    updateTemplate(ctx.db, updated)
    ctx.sim.scheduleTemplateApproval(updated)
    ctx.bus.notify({ type: 'template', template: updated })
    return {}
  },

  DeleteWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const byName = listTemplatesByName(ctx.db, waba.id, input.templateName)
    const matches = input.metaTemplateId && !input.deleteAllLanguages ? byName.filter((t) => t.metaTemplateId === input.metaTemplateId) : byName
    if (matches.length === 0) throw notFound(`Template ${input.templateName}`)
    for (const t of matches) deleteTemplate(ctx.db, t.metaTemplateId)
    ctx.bus.notify({ type: 'waba' })
    return {}
  },

  ListWhatsAppTemplateLibrary(input, ctx) {
    requireWaba(ctx, input.id)
    const f: Record<string, string> = input.filters ?? {}
    const items = LIBRARY.filter(
      (e) =>
        (!f.searchKey || `${e.templateName} ${e.templateBody}`.toLowerCase().includes(f.searchKey.toLowerCase())) &&
        (!f.topic || e.templateTopic === f.topic) &&
        (!f.usecase || e.templateUseCase === f.usecase) &&
        (!f.industry || e.templateIndustry.includes(f.industry)) &&
        (!f.language || e.templateLanguage === f.language),
    )
    const page = paginate(items, input.nextToken, input.maxResults)
    return { metaLibraryTemplates: page.items, nextToken: page.nextToken }
  },

  async CreateWhatsAppMessageTemplateMedia(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    if (!input.sourceS3File) throw invalid('sourceS3File is required')
    const { bytes, mimeType } = await readS3(ctx, input.sourceS3File)
    const handle = `4::${Buffer.from(mimeType).toString('base64')}:${randomBytes(24).toString('base64url')}`
    insertMedia(ctx.db, {
      mediaId: handle,
      ownerId: waba.id,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('base64'),
      bytes,
      createdAt: ctx.clock.now(),
    })
    return { metaHeaderHandle: handle }
  },
}
```

- [ ] **Step 6: Register the handlers**

In `src/services/socialmessaging/index.ts`, add `import { templateHandlers } from './templates.ts'` and return `{ ...wabaHandlers, ...tagHandlers, ...templateHandlers }`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/socialmessaging test/api/templates.test.ts
git commit -m "feat: template operations with approval lifecycle and library"
```

---

### Task 11: SendWhatsAppMessage

**Files:**
- Create: `src/services/socialmessaging/send.ts`
- Modify: `src/services/socialmessaging/index.ts`
- Test: `test/api/send.test.ts`

**Interfaces:**
- Consumes: `requirePhone` (Task 9), `findTemplate`, `insertMessage` (Task 4), `renderOutbound` (Task 6), `msisdn`, `newWamid` (Task 4), `ctx.sim.onSend` (Task 7)
- Produces: `sendHandlers: HandlerMap` with `SendWhatsAppMessage`

- [ ] **Step 1: Write the failing test**

`test/api/send.test.ts`:
```ts
import { DisassociateWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, describe, expect, it } from 'vitest'
import { getMessage, listMessages } from '../../src/store/messages.ts'
import { entry, PHONE_ID, startHarness, TEST_TOPIC, utf8, WABA_ID, type Harness } from '../helpers.ts'

let h: Harness
afterEach(async () => { await h.close() })

const template = (to: string, params: string[]) => utf8(JSON.stringify({
  messaging_product: 'whatsapp', to, type: 'template',
  template: { name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
}))
const PARAMS = ['Asha', 'INV-1042', '₹12,000', '9 Oct']
const send = (message: Uint8Array, originationPhoneNumberId = PHONE_ID) =>
  h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId, message, metaApiVersion: 'v20.0' }))
const statuses = () => h.published.map((p) => entry(p.envelope).changes[0].value.statuses?.[0]).filter(Boolean)

describe('SendWhatsAppMessage', () => {
  it('returns a messageId, renders the template and emits sent → delivered → read on SNS', async () => {
    h = await startHarness()
    const out = await send(template('+15550001', PARAMS))
    expect(out.messageId).toMatch(/^[0-9a-f-]{36}$/)
    const [msg] = listMessages(h.app.ctx.db, {})
    expect(msg).toMatchObject({ awsMessageId: out.messageId, peer: '+15550001', renderedText: 'Hi Asha, invoice INV-1042 of ₹12,000 is due on 9 Oct.', category: 'utility', status: 'accepted' })

    await h.clock.advance(3000)
    expect(statuses().map((s) => s.status)).toEqual(['sent', 'delivered', 'read'])
    expect(statuses()[0]).toMatchObject({ id: msg.wamid, recipient_id: '15550001', pricing: { category: 'utility', billable: true } })
    expect(h.published[0].arn).toBe(TEST_TOPIC)
    expect(h.published[0].envelope.context.MetaPhoneNumberIds).toEqual([{ metaPhoneNumberId: '200000000000001', arn: expect.stringContaining(':phone-number-id/') }])
    expect(getMessage(h.app.ctx.db, msg.wamid)?.status).toBe('read')
  })

  it('accepts the phone number ARN as originationPhoneNumberId (Review Focus 1)', async () => {
    h = await startHarness()
    const arn = (await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))).phoneNumber!.arn!
    await expect(send(template('+15550001', PARAMS), arn)).resolves.toMatchObject({ messageId: expect.any(String) })
  })

  it('returns the wamid when messageIdMode is wamid', async () => {
    h = await startHarness({ messageIdMode: 'wamid' })
    const out = await send(template('+15550001', PARAMS))
    expect(out.messageId).toMatch(/^wamid\./)
  })

  it('fails asynchronously with 132000 on a parameter mismatch', async () => {
    h = await startHarness()
    await send(template('+15550001', ['only-one']))
    await h.clock.advance(1000)
    expect(statuses()).toEqual([expect.objectContaining({ status: 'failed', errors: [expect.objectContaining({ code: 132000 })] })])
  })

  it('fails free-form text with 131047 outside the 24h window', async () => {
    h = await startHarness()
    await send(utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'hello' } })))
    await h.clock.advance(1000)
    expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131047 }] })
  })

  it('applies a failure rule from config', async () => {
    h = await startHarness({ sim: { defaultFlow: ['sent', 'delivered', 'read'], stepDelayMs: 1000, rules: [{ match: { to: '*0000' }, outcome: { status: 'failed', code: 131026 } }] } })
    await send(template('+15550000', PARAMS))
    await h.clock.advance(1000)
    expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] })
  })

  it('rejects malformed Meta payloads synchronously', async () => {
    h = await startHarness()
    for (const [message, pattern] of [
      [utf8('not json'), /not valid JSON/],
      [utf8(JSON.stringify({ to: '+1', type: 'text' })), /messaging_product/],
      [utf8(JSON.stringify({ messaging_product: 'whatsapp', type: 'text' })), /"to"/],
      [utf8(JSON.stringify({ messaging_product: 'whatsapp', to: 'abc', type: 'text' })), /"to"/],
    ] as const) {
      const err = await send(message).catch((e) => e)
      expect(err.name).toBe('InvalidParametersException')
      expect(err.message).toMatch(pattern)
    }
    const badVersion = await h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: PHONE_ID, message: template('+1', PARAMS), metaApiVersion: 'latest' })).catch((e) => e)
    expect(badVersion.message).toMatch(/metaApiVersion/)
  })

  it('returns ResourceNotFoundException for unknown and disassociated numbers (Review Focus 2)', async () => {
    h = await startHarness()
    expect((await send(template('+1', PARAMS), 'phone-number-id-nope').catch((e) => e)).name).toBe('ResourceNotFoundException')
    await send(template('+15550001', PARAMS))
    await h.client.send(new DisassociateWhatsAppBusinessAccountCommand({ id: WABA_ID }))
    await h.clock.advance(5000)
    expect(h.published).toEqual([])
    expect((await send(template('+1', PARAMS)).catch((e) => e)).name).toBe('ResourceNotFoundException')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/send.test.ts`
Expected: FAIL — `SendWhatsAppMessage` returns 501.

- [ ] **Step 3: Implement the send handler**

`src/services/socialmessaging/send.ts`:
```ts
import { randomUUID } from 'node:crypto'
import type { HandlerMap } from '../../context.ts'
import { msisdn, newWamid } from '../../domain/ids.ts'
import { renderOutbound } from '../../domain/render.ts'
import { invalid } from '../../smithy/errors.ts'
import { insertMessage } from '../../store/messages.ts'
import { findTemplate } from '../../store/templates.ts'
import type { MessageRow } from '../../store/types.ts'
import { requirePhone } from './waba.ts'

export const sendHandlers: HandlerMap = {
  SendWhatsAppMessage(input, ctx) {
    const { phone, waba } = requirePhone(ctx, input.originationPhoneNumberId)
    if (waba.registrationStatus !== 'COMPLETE') throw invalid(`WhatsApp Business Account ${waba.id} has not finished setup`)
    if (!/^v\d+\.\d+$/.test(input.metaApiVersion)) throw invalid(`metaApiVersion must look like v20.0, got ${input.metaApiVersion}`)

    let body: any
    try {
      body = JSON.parse(Buffer.from(input.message).toString('utf8'))
    } catch {
      throw invalid('message is not valid JSON')
    }
    if (body?.messaging_product !== 'whatsapp') throw invalid('message must set "messaging_product": "whatsapp"')
    const peer = typeof body.to === 'string' ? msisdn(body.to) : ''
    if (!peer) throw invalid('message must set "to" to the recipient phone number')
    if (typeof body.type !== 'string' || !body.type) throw invalid('message must set "type"')

    const template = body.type === 'template' && body.template?.name
      ? findTemplate(ctx.db, waba.id, String(body.template.name), String(body.template.language?.code ?? ''))
      : undefined
    const wamid = newWamid()
    const msg: MessageRow = {
      wamid,
      awsMessageId: ctx.config.messageIdMode === 'wamid' ? wamid : randomUUID(),
      phoneNumberId: phone.id,
      direction: 'out',
      peer,
      type: body.type,
      body,
      renderedText: renderOutbound(body, template),
      category: body.type === 'template' ? (template?.category.toLowerCase() ?? 'utility') : 'service',
      status: 'accepted',
      createdAt: ctx.clock.now(),
    }
    insertMessage(ctx.db, msg)
    ctx.bus.notify({ type: 'message', message: msg })
    ctx.sim.onSend(msg, template)
    return { messageId: msg.awsMessageId }
  },
}
```

- [ ] **Step 4: Register the handler**

In `src/services/socialmessaging/index.ts`, add `import { sendHandlers } from './send.ts'` and include `...sendHandlers` in the returned map.

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/socialmessaging test/api/send.test.ts
git commit -m "feat: SendWhatsAppMessage with Meta async failures and SNS delivery"
```

---

### Task 12: Media operations

**Files:**
- Create: `src/services/socialmessaging/media.ts`
- Modify: `src/services/socialmessaging/index.ts`
- Test: `test/api/media.test.ts`

**Interfaces:**
- Consumes: `requirePhone` (Task 9), `readS3`, `writeS3`, `guessMime` (Task 10), media repos (Task 4), `metaNumericId` (Task 4)
- Produces: `MAX_MEDIA_BYTES = 100 * 1024 * 1024`, `mediaHandlers: HandlerMap` (3 ops)

- [ ] **Step 1: Write the failing test**

`test/api/media.test.ts`:
```ts
import { DeleteWhatsAppMessageMediaCommand, GetWhatsAppMessageMediaCommand, PostWhatsAppMessageMediaCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PHONE_ID, startHarness, utf8, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })

describe('media operations', () => {
  it('uploads from S3, reads metadata, copies back to S3 and deletes', async () => {
    await h.blobs.put('in', 'invoice.pdf', utf8('%PDF-1.7'), 'application/pdf')
    const { mediaId } = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'in', key: 'invoice.pdf' } }))
    expect(mediaId).toMatch(/^\d+$/)

    expect(await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, metadataOnly: true })))
      .toMatchObject({ mimeType: 'application/pdf', fileSize: 8 })

    await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, destinationS3File: { bucketName: 'out', key: 'copy.pdf' } }))
    expect(Buffer.from(h.blobs.objects.get('out/copy.pdf')!.bytes).toString()).toBe('%PDF-1.7')

    expect(await h.client.send(new DeleteWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId! }))).toMatchObject({ success: true })
    const gone = await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, metadataOnly: true })).catch((e) => e)
    expect(gone.name).toBe('ResourceNotFoundException')
  })

  it('serves media received from a customer', async () => {
    const m = await h.app.ctx.sim.inbound({ phoneNumberId: PHONE_ID, from: '+15550001', type: 'image', mediaBase64: Buffer.from('img').toString('base64'), mimeType: 'image/png' })
    expect(await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: m.body.image.id, metadataOnly: true })))
      .toMatchObject({ mimeType: 'image/png', fileSize: 3 })
  })

  it('requires exactly one source and a destination unless metadataOnly', async () => {
    const none = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID })).catch((e) => e)
    expect(none.name).toBe('InvalidParametersException')
    const missing = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'in', key: 'nope' } })).catch((e) => e)
    expect(missing.message).toMatch(/Could not read s3:\/\/in\/nope/)
    await h.blobs.put('in', 'a.png', utf8('x'), 'image/png')
    const { mediaId } = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'in', key: 'a.png' } }))
    const noDest = await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId! })).catch((e) => e)
    expect(noDest.name).toBe('InvalidParametersException')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/media.test.ts`
Expected: FAIL — media operations return 501.

- [ ] **Step 3: Implement media handlers**

`src/services/socialmessaging/media.ts`:
```ts
import { createHash } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId } from '../../domain/ids.ts'
import { invalid, notFound } from '../../smithy/errors.ts'
import { deleteMedia, getMedia, insertMedia } from '../../store/media.ts'
import type { MediaRow } from '../../store/types.ts'
import { guessMime, readS3, writeS3 } from './s3io.ts'
import { requirePhone } from './waba.ts'

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function fetchSource(ctx: Ctx, input: any): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (input.sourceS3File && input.sourceS3PresignedUrl) throw invalid('Provide only one of sourceS3File or sourceS3PresignedUrl')
  if (input.sourceS3File) return readS3(ctx, input.sourceS3File)
  if (input.sourceS3PresignedUrl) {
    const { url, headers } = input.sourceS3PresignedUrl
    let res: Response
    try {
      res = await fetch(url, { headers })
    } catch (err) {
      throw invalid(`Could not fetch sourceS3PresignedUrl: ${reason(err)}`)
    }
    if (!res.ok) throw invalid(`sourceS3PresignedUrl returned HTTP ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get('content-type') ?? guessMime(url) }
  }
  throw invalid('Provide sourceS3File or sourceS3PresignedUrl')
}

function requireMedia(ctx: Ctx, phoneId: string, mediaId: string): MediaRow {
  const m = getMedia(ctx.db, mediaId)
  if (!m || m.ownerId !== phoneId) throw notFound(`Media ${mediaId}`)
  return m
}

export const mediaHandlers: HandlerMap = {
  async PostWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId)
    const { bytes, mimeType } = await fetchSource(ctx, input)
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw invalid(`Media is ${bytes.byteLength} bytes; the limit is ${MAX_MEDIA_BYTES}`)
    const mediaId = metaNumericId()
    insertMedia(ctx.db, { mediaId, ownerId: phone.id, mimeType, sha256: createHash('sha256').update(bytes).digest('base64'), bytes, createdAt: ctx.clock.now() })
    return { mediaId }
  },

  async GetWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId)
    const m = requireMedia(ctx, phone.id, input.mediaId)
    if (!input.metadataOnly) {
      if (input.destinationS3File) {
        await writeS3(ctx, input.destinationS3File, m.bytes, m.mimeType)
      } else if (input.destinationS3PresignedUrl) {
        const { url, headers } = input.destinationS3PresignedUrl
        let res: Response
        try {
          res = await fetch(url, { method: 'PUT', headers, body: Buffer.from(m.bytes) })
        } catch (err) {
          throw invalid(`Could not upload to destinationS3PresignedUrl: ${reason(err)}`)
        }
        if (!res.ok) throw invalid(`destinationS3PresignedUrl returned HTTP ${res.status}`)
      } else {
        throw invalid('Provide destinationS3File or destinationS3PresignedUrl, or set metadataOnly')
      }
    }
    return { mimeType: m.mimeType, fileSize: m.bytes.byteLength }
  },

  DeleteWhatsAppMessageMedia(input, ctx) {
    const { phone } = requirePhone(ctx, input.originationPhoneNumberId)
    requireMedia(ctx, phone.id, input.mediaId)
    deleteMedia(ctx.db, input.mediaId)
    return { success: true }
  },
}
```

- [ ] **Step 4: Register the handlers**

In `src/services/socialmessaging/index.ts`, add `import { mediaHandlers } from './media.ts'` and include `...mediaHandlers`. The final file:
```ts
import type { HandlerMap } from '../../context.ts'
import { mediaHandlers } from './media.ts'
import { sendHandlers } from './send.ts'
import { tagHandlers } from './tags.ts'
import { templateHandlers } from './templates.ts'
import { wabaHandlers } from './waba.ts'

// Each simulated area contributes its handlers here; operations without one return 501.
export function socialMessagingHandlers(): HandlerMap {
  return { ...wabaHandlers, ...tagHandlers, ...templateHandlers, ...sendHandlers, ...mediaHandlers }
}
```

- [ ] **Step 5: Add a coverage assertion**

Append to `test/api/pipeline.test.ts`, inside the `describe`:
```ts
  it('simulates exactly the 22 v1 operations', async () => {
    const { coverage } = await import('../../src/api/aws.ts')
    const c = coverage(h.app.model, h.app.handlers)
    expect(c.simulated).toHaveLength(22)
    expect(c.notSimulated).toHaveLength(16)
    expect(c.notSimulated.every((n) => /Flow|Call|Dataset|ConversionEvent|BusinessPublicKey/.test(n))).toBe(true)
  })
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/socialmessaging test/api/media.test.ts test/api/pipeline.test.ts
git commit -m "feat: media operations over S3 and coverage check"
```

---

### Task 13: Admin API and SSE stream

**Files:**
- Create: `src/api/admin.ts`
- Modify: `src/server.ts` (register admin API)
- Test: `test/api/admin.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `HandlerMap` (Task 8), `coverage` (Task 8), `createWaba`, `seedFromConfig`, repos, `resetDb` (Task 4), `Simulator` (Task 7), `metaError` (Task 4), `STATUS_NAMES` (Task 4)
- Produces: `registerAdminApi(app: FastifyInstance, ctx: Ctx, handlers: HandlerMap): void`, `readModelSource(): Record<string, string>` and these routes (all JSON; errors `{ error }`):
  - `GET /_eum/api/coverage` → `{ model, simulated, notSimulated }`
  - `GET /_eum/api/wabas` → `{ wabas: (WabaRow & { phoneNumbers: PhoneRow[] })[] }`; `POST /_eum/api/wabas` (body `WabaSeed`) → 201 `{ waba }`
  - `GET /_eum/api/messages?phoneNumberId&peer&status&limit` → `{ messages }`; `GET /_eum/api/messages/:wamid` → `{ message, history, events }`
  - `POST /_eum/api/messages/:wamid/status` `{ status, code?, title? }` → `{ message }`
  - `POST /_eum/api/inbound` (`InboundInput`) → 201 `{ message }`
  - `GET /_eum/api/templates?wabaId` → `{ templates }`; `POST /_eum/api/templates/:id/approve` and `/reject` `{ reason? }` → `{ template }`
  - `GET /_eum/api/events?kind&wamid&limit` → `{ events }`
  - `GET /_eum/api/media/:id` → raw bytes with the stored content type
  - `GET /_eum/api/stream` → SSE, one `event: <BusEvent.type>` per bus notification
  - `POST /_eum/api/reset` → `{ ok: true }`

- [ ] **Step 1: Write the failing test**

`test/api/admin.test.ts`:
```ts
import { SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entry, PHONE_ID, startHarness, utf8, WABA_ID, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${h.url}/_eum/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const sendTemplate = () => h.client.send(new SendWhatsAppMessageCommand({
  originationPhoneNumberId: PHONE_ID, metaApiVersion: 'v20.0',
  message: utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: ['a', 'b', 'c', 'd'].map((text) => ({ type: 'text', text })) }] } })),
}))

describe('admin API', () => {
  it('reports coverage and model provenance', async () => {
    const { json } = await api('GET', '/coverage')
    expect(json.simulated).toContain('SendWhatsAppMessage')
    expect(json.notSimulated).toContain('CreateWhatsAppFlow')
    expect(json.model.commit).toMatch(/^[0-9a-f]{7}$/)
  })

  it('lists WABAs with phones and creates new ones', async () => {
    expect((await api('GET', '/wabas')).json.wabas[0]).toMatchObject({ id: WABA_ID, phoneNumbers: [{ id: PHONE_ID }] })
    const created = await api('POST', '/wabas', { name: 'Second', phoneNumbers: [{ phoneNumber: '+919800000002', displayName: 'Two' }] })
    expect(created.status).toBe(201)
    expect((await api('GET', '/wabas')).json.wabas).toHaveLength(2)
    expect((await api('POST', '/wabas', { phoneNumbers: [] })).status).toBe(400)
  })

  it('shows a message with history and events, and pushes a manual status', async () => {
    await sendTemplate()
    await h.clock.advance(1000)
    const [m] = (await api('GET', '/messages')).json.messages
    const pushed = await api('POST', `/messages/${m.wamid}/status`, { status: 'failed', code: 131050 })
    expect(pushed.json.message).toMatchObject({ status: 'failed', errorCode: 131050 })
    const detail = (await api('GET', `/messages/${m.wamid}`)).json
    expect(detail.history.map((x: any) => x.status)).toEqual(['accepted', 'sent', 'failed'])
    expect(detail.events).toHaveLength(2)
    expect(entry(h.published.at(-1)!.envelope).changes[0].value.statuses[0].errors[0].code).toBe(131050)
    expect((await api('POST', `/messages/${m.wamid}/status`, { status: 'bogus' })).status).toBe(400)
    expect((await api('POST', '/messages/wamid.none/status', { status: 'read' })).status).toBe(404)
  })

  it('accepts inbound customer messages, including STOP', async () => {
    const res = await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+15550001', type: 'text', text: 'STOP' })
    expect(res.status).toBe(201)
    expect(entry(h.published.at(-1)!.envelope).changes[0].value.messages[0].text.body).toBe('STOP')
    expect((await api('POST', '/inbound', { phoneNumberId: 'phone-number-id-x', from: '+1', type: 'text', text: 'x' })).status).toBe(404)
    expect((await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+1', type: 'video' })).status).toBe(400)
  })

  it('approves and rejects templates by hand', async () => {
    const [t] = (await api('GET', '/templates')).json.templates
    const res = await api('POST', `/templates/${t.metaTemplateId}/reject`, { reason: 'INVALID_FORMAT' })
    expect(res.json.template.status).toBe('REJECTED')
    expect(entry(h.published.at(-1)!.envelope).changes[0].value).toMatchObject({ event: 'REJECTED', reason: 'INVALID_FORMAT' })
    expect((await api('POST', '/templates/999/approve', {})).status).toBe(404)
  })

  it('serves stored media bytes', async () => {
    const m = await h.app.ctx.sim.inbound({ phoneNumberId: PHONE_ID, from: '+1555', type: 'image', mediaBase64: Buffer.from('img').toString('base64'), mimeType: 'image/png' })
    const res = await fetch(`${h.url}/_eum/api/media/${m.body.image.id}`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('img')
  })

  it('resets data, cancels scheduled deliveries and re-seeds (Review Focus 2)', async () => {
    await sendTemplate()
    expect((await api('POST', '/reset', {})).json).toEqual({ ok: true })
    await h.clock.advance(10_000)
    expect(h.published).toEqual([])
    expect((await api('GET', '/messages')).json.messages).toEqual([])
    expect((await api('GET', '/wabas')).json.wabas[0].id).toBe(WABA_ID)
  })

  it('streams bus events over SSE', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${h.url}/_eum/api/stream`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    await reader.read()
    await api('POST', '/inbound', { phoneNumberId: PHONE_ID, from: '+15550001', type: 'text', text: 'hi' })
    let text = ''
    while (!text.includes('event: message')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('event: event')
    ctrl.abort()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/admin.test.ts`
Expected: FAIL — admin routes return 404.

- [ ] **Step 3: Implement the admin API**

`src/api/admin.ts`:
```ts
import { readFileSync } from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { STATUS_NAMES, type StatusName, type WabaSeed } from '../config.ts'
import type { Ctx, HandlerMap } from '../context.ts'
import { metaError } from '../domain/metaErrors.ts'
import { resetDb } from '../store/db.ts'
import { listEvents } from '../store/events.ts'
import { getMedia } from '../store/media.ts'
import { getMessage, listMessages, statusHistory } from '../store/messages.ts'
import { createWaba, seedFromConfig } from '../store/seed.ts'
import { listTemplates } from '../store/templates.ts'
import type { EventKind } from '../store/types.ts'
import { listPhones, listWabas } from '../store/wabas.ts'
import { coverage } from './aws.ts'

const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error })
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function readModelSource(): Record<string, string> {
  const text = readFileSync(new URL('../../models/SOURCE', import.meta.url), 'utf8')
  return Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))
}

export function registerAdminApi(app: FastifyInstance, ctx: Ctx, handlers: HandlerMap): void {
  const { db, sim, bus } = ctx
  const p = '/_eum/api'

  app.get(`${p}/coverage`, async () => ({ model: readModelSource(), ...coverage(ctx.model, handlers) }))

  app.get(`${p}/wabas`, async () => ({ wabas: listWabas(db).map((w) => ({ ...w, phoneNumbers: listPhones(db, w.id) })) }))

  app.post(`${p}/wabas`, async (req, reply) => {
    const seed = req.body as WabaSeed
    if (!seed?.name) return fail(reply, 400, 'name is required')
    try {
      const waba = createWaba(db, ctx.config, seed, ctx.clock.now())
      bus.notify({ type: 'waba' })
      return reply.code(201).send({ waba })
    } catch (err) {
      return fail(reply, 400, errorText(err))
    }
  })

  app.get(`${p}/messages`, async (req) => {
    const q = req.query as Record<string, string | undefined>
    return { messages: listMessages(db, { phoneNumberId: q.phoneNumberId, peer: q.peer, status: q.status, limit: q.limit ? Number(q.limit) : undefined }) }
  })

  app.get(`${p}/messages/:wamid`, async (req, reply) => {
    const { wamid } = req.params as { wamid: string }
    const message = getMessage(db, wamid)
    if (!message) return fail(reply, 404, `message ${wamid} not found`)
    return { message, history: statusHistory(db, wamid), events: listEvents(db, { wamid }) }
  })

  app.post(`${p}/messages/:wamid/status`, async (req, reply) => {
    const { wamid } = req.params as { wamid: string }
    const b = (req.body ?? {}) as { status?: string; code?: number; title?: string }
    if (!(STATUS_NAMES as readonly string[]).includes(b.status ?? '')) return fail(reply, 400, `status must be one of ${STATUS_NAMES.join(', ')}`)
    const status = b.status as StatusName
    const message = await sim.applyStatus(wamid, status, status === 'failed' ? metaError(Number(b.code ?? 131026), b.title) : undefined)
    if (!message) return fail(reply, 404, `message ${wamid} not found`)
    return { message }
  })

  app.post(`${p}/inbound`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>
    if (!['text', 'button', 'image'].includes(b.type)) return fail(reply, 400, 'type must be text, button or image')
    try {
      return reply.code(201).send({ message: await sim.inbound(b as any) })
    } catch (err) {
      const msg = errorText(err)
      return fail(reply, msg.startsWith('unknown phone number') ? 404 : 400, msg)
    }
  })

  app.get(`${p}/templates`, async (req) => ({ templates: listTemplates(db, (req.query as { wabaId?: string }).wabaId) }))

  for (const [action, status] of [['approve', 'APPROVED'], ['reject', 'REJECTED']] as const) {
    app.post(`${p}/templates/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        return { template: await sim.setTemplateStatus(id, status, (req.body as { reason?: string } | undefined)?.reason) }
      } catch (err) {
        return fail(reply, 404, errorText(err))
      }
    })
  }

  app.get(`${p}/events`, async (req) => {
    const q = req.query as Record<string, string | undefined>
    return { events: listEvents(db, { kind: q.kind as EventKind | undefined, wamid: q.wamid, limit: q.limit ? Number(q.limit) : undefined }) }
  })

  app.get(`${p}/media/:id`, async (req, reply) => {
    const m = getMedia(db, (req.params as { id: string }).id)
    if (!m) return fail(reply, 404, 'media not found')
    return reply.type(m.mimeType).send(Buffer.from(m.bytes))
  })

  app.get(`${p}/stream`, (req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    reply.raw.write(': connected\n\n')
    const off = bus.subscribe((e) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
    req.raw.on('close', off)
  })

  app.post(`${p}/reset`, async () => {
    ctx.clock.cancelAll()
    resetDb(db)
    seedFromConfig(db, ctx.config, ctx.clock.now())
    bus.notify({ type: 'reset' })
    return { ok: true }
  })
}
```

- [ ] **Step 4: Register in the server**

In `src/server.ts`, add `import { registerAdminApi } from './api/admin.ts'` and, right after `registerAwsApi(...)`, add:
```ts
  registerAdminApi(fastify, ctx, handlers)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/admin.ts src/server.ts test/api/admin.test.ts
git commit -m "feat: admin API with manual status, inbound, reset and SSE"
```

---

### Task 14: Inbox UI and entry point

**Files:**
- Create: `ui/index.html`, `ui/vite.config.ts`, `ui/src/main.tsx`, `ui/src/api.ts`, `ui/src/App.tsx`, `ui/src/Sidebar.tsx`, `ui/src/Thread.tsx`, `ui/src/Inspector.tsx`, `ui/src/Templates.tsx`, `ui/src/Events.tsx`, `ui/src/styles.css`, `src/api/ui.ts`, `src/main.ts`
- Modify: `src/server.ts` (register UI)
- Test: `test/api/ui.test.ts`

**Interfaces:**
- Consumes: the admin API routes (Task 13)
- Produces: `registerUi(app: FastifyInstance): Promise<void>` — serves `ui/dist` at `/_eum/ui/` (redirects `/` and `/_eum/ui`), or a plain-text hint when the UI is not built; `src/main.ts` CLI entry.

- [ ] **Step 1: Write the failing test**

`test/api/ui.test.ts`:
```ts
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type Harness } from '../helpers.ts'

let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })

describe('UI route', () => {
  it('redirects / to the inbox', async () => {
    const res = await fetch(`${h.url}/`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/_eum/ui/')
  })

  it('serves the built inbox, or explains how to build it', async () => {
    const res = await fetch(`${h.url}/_eum/ui/`)
    const text = await res.text()
    if (existsSync(new URL('../../ui/dist/index.html', import.meta.url))) expect(text).toContain('<div id="app">')
    else expect(text).toMatch(/npm run ui:build/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/ui.test.ts`
Expected: FAIL — `/` returns 404.

- [ ] **Step 3: Implement the UI route and entry point**

`src/api/ui.ts`:
```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

export async function registerUi(app: FastifyInstance): Promise<void> {
  const root = fileURLToPath(new URL('../../ui/dist/', import.meta.url))
  app.get('/', (_req, reply) => reply.redirect('/_eum/ui/'))
  app.get('/_eum/ui', (_req, reply) => reply.redirect('/_eum/ui/'))
  if (!existsSync(`${root}index.html`)) {
    app.get('/_eum/ui/*', (_req, reply) => reply.type('text/plain').send('The eum-social-local-emulator inbox is not built yet. Run: npm run ui:build'))
    return
  }
  await app.register(fastifyStatic, { root, prefix: '/_eum/ui/' })
}
```

In `src/server.ts`, add `import { registerUi } from './api/ui.ts'` and, after `registerAdminApi(...)`, add:
```ts
  await registerUi(fastify)
```

`src/main.ts`:
```ts
import { coverage } from './api/aws.ts'
import { loadConfig } from './config.ts'
import { buildApp } from './server.ts'
import { listPhones, listWabas } from './store/wabas.ts'

const config = loadConfig()
const app = await buildApp({ config })
await app.fastify.listen({ port: config.port, host: config.host })

const base = `http://localhost:${config.port}`
const cov = coverage(app.model, app.handlers)
const lines = [
  '',
  `eum-social-local-emulator — AWS End User Messaging Social emulator`,
  `  SDK endpoint : ${base}`,
  `  Inbox        : ${base}/_eum/ui/`,
  `  Operations   : ${cov.simulated.length} simulated, ${cov.notSimulated.length} routed but not simulated`,
  `  Events       : ${config.aws ? `SNS via ${config.aws.endpoint}` : 'stored only (no aws.endpoint configured)'}`,
  '',
  ...listWabas(app.ctx.db).flatMap((w) => [
    `  WABA ${w.name}  ${w.id}`,
    ...listPhones(app.ctx.db, w.id).map((p) => `    ${p.phoneNumber}  ${p.id}`),
  ]),
  '',
]
console.log(lines.join('\n'))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0))
  })
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/api/ui.test.ts`
Expected: PASS (UI not built yet → hint text).

- [ ] **Step 5: Write the UI shell**

`ui/vite.config.ts`:
```ts
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/_eum/ui/',
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/_eum/api': 'http://localhost:4580' } },
})
```

`ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>eum-social-local-emulator inbox</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`ui/src/main.tsx`:
```tsx
import { render } from 'preact'
import { App } from './App.tsx'
import './styles.css'

render(<App />, document.getElementById('app')!)
```

`ui/src/api.ts`:
```ts
export interface Phone { id: string; wabaId: string; phoneNumber: string; displayName: string; metaPhoneNumberId: string }
export interface Waba { id: string; name: string; metaWabaId: string; registrationStatus: string; eventDestinations: { eventDestinationArn: string }[]; phoneNumbers: Phone[] }
export interface Message {
  wamid: string; awsMessageId?: string; phoneNumberId: string; direction: 'out' | 'in'; peer: string; type: string; body: any
  renderedText?: string; status: string; errorCode?: number; errorTitle?: string; createdAt: number
}
export interface Template { metaTemplateId: string; wabaId: string; name: string; language: string; category: string; status: string; components: { type: string; text?: string }[] }
export interface Delivery { destination: string; ok: boolean; detail: string }
export interface EventRow { id: string; kind: string; wamid?: string; envelope: { whatsAppWebhookEntry: string; [k: string]: unknown }; deliveries: Delivery[]; at: number }
export interface MessageDetail { message: Message; history: { status: string; errorCode?: number; at: number }[]; events: EventRow[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/_eum/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json as T
}

export const api = {
  wabas: () => call<{ wabas: Waba[] }>('GET', '/wabas'),
  messages: () => call<{ messages: Message[] }>('GET', '/messages?limit=1000'),
  message: (wamid: string) => call<MessageDetail>('GET', `/messages/${encodeURIComponent(wamid)}`),
  setStatus: (wamid: string, status: string, code?: number) => call('POST', `/messages/${encodeURIComponent(wamid)}/status`, { status, code }),
  inbound: (b: { phoneNumberId: string; from: string; type: 'text' | 'image'; text?: string; mediaBase64?: string; mimeType?: string }) =>
    call<{ message: Message }>('POST', '/inbound', b),
  templates: () => call<{ templates: Template[] }>('GET', '/templates'),
  approve: (id: string) => call('POST', `/templates/${id}/approve`, {}),
  reject: (id: string, reason: string) => call('POST', `/templates/${id}/reject`, { reason }),
  events: () => call<{ events: EventRow[] }>('GET', '/events?limit=300'),
  reset: () => call('POST', '/reset', {}),
}

export function onChange(fn: () => void): () => void {
  const es = new EventSource('/_eum/api/stream')
  for (const type of ['message', 'status', 'event', 'template', 'waba', 'reset']) es.addEventListener(type, fn)
  return () => es.close()
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
```

- [ ] **Step 6: Write the UI components**

`ui/src/App.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, errorText, onChange, type Message, type Waba } from './api.ts'
import { Events } from './Events.tsx'
import { Inspector } from './Inspector.tsx'
import { Sidebar, type Thread } from './Sidebar.tsx'
import { Templates } from './Templates.tsx'
import { ThreadView } from './Thread.tsx'

type View = 'inbox' | 'templates' | 'events'

function groupThreads(messages: Message[]): Thread[] {
  const map = new Map<string, Thread>()
  for (const m of messages) {
    const key = `${m.phoneNumberId}|${m.peer}`
    const t = map.get(key) ?? { key, phoneNumberId: m.phoneNumberId, peer: m.peer, last: m }
    if (m.createdAt >= t.last.createdAt) t.last = m
    map.set(key, t)
  }
  return [...map.values()].sort((a, b) => b.last.createdAt - a.last.createdAt)
}

export function App() {
  const [view, setView] = useState<View>('inbox')
  const [wabas, setWabas] = useState<Waba[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [threadKey, setThreadKey] = useState<string | null>(null)
  const [wamid, setWamid] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.wabas(), api.messages()])
      .then(([w, m]) => {
        setWabas(w.wabas)
        setMessages(m.messages)
      })
      .catch((e) => setError(errorText(e)))
  }, [tick])
  useEffect(() => onChange(() => setTick((t) => t + 1)), [])

  const threads = useMemo(() => groupThreads(messages), [messages])
  const thread = threads.find((t) => t.key === threadKey) ?? null
  const threadMessages = useMemo(
    () => (thread ? messages.filter((m) => `${m.phoneNumberId}|${m.peer}` === thread.key).sort((a, b) => a.createdAt - b.createdAt) : []),
    [messages, thread],
  )

  async function reset() {
    if (!confirm('Delete all messages, events and API-created data, then re-seed from config?')) return
    await api.reset().catch((e) => setError(errorText(e)))
    setThreadKey(null)
    setWamid(null)
  }

  return (
    <div class="app">
      <header class="topbar">
        <strong>eum-social-local-emulator</strong>
        <span class="muted">AWS End User Messaging · WhatsApp</span>
        <nav>
          {(['inbox', 'templates', 'events'] as View[]).map((v) => (
            <button key={v} class={view === v ? 'tab active' : 'tab'} onClick={() => setView(v)}>{v}</button>
          ))}
        </nav>
        <button class="danger" onClick={reset}>Reset all</button>
      </header>
      {error && <div class="error" onClick={() => setError(null)}>{error} <span class="muted">(click to dismiss)</span></div>}
      {view === 'inbox' && (
        <main class="inbox">
          <Sidebar wabas={wabas} threads={threads} selected={threadKey} onSelect={(k) => { setThreadKey(k); setWamid(null) }} onError={setError} />
          <ThreadView wabas={wabas} thread={thread} messages={threadMessages} selected={wamid} onSelect={setWamid} onError={setError} />
          <Inspector wamid={wamid} tick={tick} onError={setError} />
        </main>
      )}
      {view === 'templates' && <Templates wabas={wabas} tick={tick} onError={setError} />}
      {view === 'events' && <Events tick={tick} />}
    </div>
  )
}
```

`ui/src/Sidebar.tsx`:
```tsx
import { useState } from 'preact/hooks'
import { api, errorText, type Message, type Waba } from './api.ts'

export interface Thread { key: string; phoneNumberId: string; peer: string; last: Message }

interface Props {
  wabas: Waba[]
  threads: Thread[]
  selected: string | null
  onSelect: (key: string) => void
  onError: (e: string) => void
}

export function Sidebar({ wabas, threads, selected, onSelect, onError }: Props) {
  const phones = wabas.flatMap((w) => w.phoneNumbers)
  const [phoneId, setPhoneId] = useState('')
  const [from, setFrom] = useState('+919800001234')
  const [text, setText] = useState('Hi, I have a question about my invoice')
  const target = phoneId || phones[0]?.id || ''

  async function start(e: Event) {
    e.preventDefault()
    try {
      const { message } = await api.inbound({ phoneNumberId: target, from, type: 'text', text })
      onSelect(`${message.phoneNumberId}|${message.peer}`)
    } catch (err) {
      onError(errorText(err))
    }
  }

  return (
    <aside class="sidebar">
      {wabas.map((w) => (
        <section key={w.id}>
          <h3 title={w.id}>{w.name} <span class="badge">{w.registrationStatus}</span></h3>
          {w.phoneNumbers.map((p) => (
            <div key={p.id} class="phone">
              <div class="phone-head">{p.displayName} · {p.phoneNumber}</div>
              <code class="small">{p.id}</code>
              {threads.filter((t) => t.phoneNumberId === p.id).map((t) => (
                <button key={t.key} class={t.key === selected ? 'thread active' : 'thread'} onClick={() => onSelect(t.key)}>
                  <span>{t.peer}</span>
                  <span class="muted ellipsis">{t.last.renderedText ?? t.last.type}</span>
                </button>
              ))}
            </div>
          ))}
        </section>
      ))}
      <form class="new-thread" onSubmit={start}>
        <h4>Message as a customer</h4>
        <select value={target} onChange={(e) => setPhoneId((e.target as HTMLSelectElement).value)}>
          {phones.map((p) => <option key={p.id} value={p.id}>{p.displayName} {p.phoneNumber}</option>)}
        </select>
        <input value={from} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} placeholder="+919800001234" />
        <input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={!target}>Send inbound</button>
      </form>
    </aside>
  )
}
```

`ui/src/Thread.tsx`:
```tsx
import { useState } from 'preact/hooks'
import { api, errorText, type Message, type Waba } from './api.ts'
import type { Thread } from './Sidebar.tsx'

const TICKS: Record<string, string> = { accepted: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' }

interface Props {
  wabas: Waba[]
  thread: Thread | null
  messages: Message[]
  selected: string | null
  onSelect: (wamid: string) => void
  onError: (e: string) => void
}

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

export function ThreadView({ wabas, thread, messages, selected, onSelect, onError }: Props) {
  const [text, setText] = useState('')
  if (!thread) return <section class="thread-view empty">Select a conversation, or send an inbound message to start one.</section>
  const t = thread
  const phone = wabas.flatMap((w) => w.phoneNumbers).find((p) => p.id === t.phoneNumberId)

  async function reply(body: string) {
    if (!body.trim()) return
    try {
      await api.inbound({ phoneNumberId: t.phoneNumberId, from: t.peer, type: 'text', text: body })
      setText('')
    } catch (e) {
      onError(errorText(e))
    }
  }

  async function sendImage(file: File) {
    try {
      await api.inbound({ phoneNumberId: t.phoneNumberId, from: t.peer, type: 'image', mediaBase64: await toBase64(file), mimeType: file.type || 'image/jpeg', text: file.name })
    } catch (e) {
      onError(errorText(e))
    }
  }

  return (
    <section class="thread-view">
      <div class="thread-head">{t.peer} <span class="muted">↔ {phone?.displayName} {phone?.phoneNumber}</span></div>
      <div class="bubbles">
        {messages.map((m) => (
          <button key={m.wamid} class={`bubble ${m.direction}${m.wamid === selected ? ' selected' : ''}`} onClick={() => onSelect(m.wamid)}>
            {m.type === 'template' && <div class="tag">template · {m.body?.template?.name}</div>}
            {m.direction === 'in' && m.type === 'image' && m.body?.image?.id && <img src={`/_eum/api/media/${m.body.image.id}`} alt="" />}
            <div class="text">{m.renderedText ?? `[${m.type}]`}</div>
            <div class="meta">
              {new Date(m.createdAt).toLocaleTimeString()}{' '}
              {m.direction === 'out' && (
                <span class={`tick ${m.status}`} title={m.errorCode ? `${m.errorCode} ${m.errorTitle}` : m.status}>{TICKS[m.status] ?? m.status}</span>
              )}
            </div>
          </button>
        ))}
      </div>
      <form class="composer" onSubmit={(e) => { e.preventDefault(); reply(text) }}>
        <input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder={`Reply as ${t.peer}`} />
        <button type="submit">Send</button>
        <button type="button" class="danger" onClick={() => reply('STOP')}>STOP</button>
        <label class="file">
          Image
          <input type="file" accept="image/*" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) sendImage(f) }} />
        </label>
      </form>
    </section>
  )
}
```

`ui/src/Inspector.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks'
import { api, errorText, type MessageDetail } from './api.ts'

const CODES = [131026, 131047, 131049, 131050, 132000, 132001]

export function Inspector({ wamid, tick, onError }: { wamid: string | null; tick: number; onError: (e: string) => void }) {
  const [data, setData] = useState<MessageDetail | null>(null)
  const [code, setCode] = useState(131026)

  useEffect(() => {
    if (!wamid) return setData(null)
    api.message(wamid).then(setData).catch((e) => onError(errorText(e)))
  }, [wamid, tick])

  if (!data) return <aside class="inspector empty">Select a message to inspect it.</aside>
  const m = data.message
  const push = (status: string, c?: number) => api.setStatus(m.wamid, status, c).catch((e) => onError(errorText(e)))

  return (
    <aside class="inspector">
      <h4>Message</h4>
      <dl>
        <dt>wamid</dt><dd><code>{m.wamid}</code></dd>
        {m.awsMessageId && <><dt>AWS messageId</dt><dd><code>{m.awsMessageId}</code></dd></>}
        <dt>status</dt><dd>{m.status}{m.errorCode ? ` (${m.errorCode} ${m.errorTitle})` : ''}</dd>
      </dl>
      {m.direction === 'out' && (
        <div class="actions">
          <button onClick={() => push('delivered')}>Mark delivered</button>
          <button onClick={() => push('read')}>Mark read</button>
          <select value={code} onChange={(e) => setCode(Number((e.target as HTMLSelectElement).value))}>
            {CODES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button class="danger" onClick={() => push('failed', code)}>Fail</button>
        </div>
      )}
      <h4>Payload</h4>
      <pre>{JSON.stringify(m.body, null, 2)}</pre>
      <h4>Status history</h4>
      <ol>{data.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleTimeString()} {h.status}{h.errorCode ? ` ${h.errorCode}` : ''}</li>)}</ol>
      <h4>Events ({data.events.length})</h4>
      {data.events.map((ev) => (
        <details key={ev.id}>
          <summary>{ev.kind} · {ev.deliveries.map((d) => (d.ok ? '✓' : '✗')).join(' ') || 'no destinations'}</summary>
          {ev.deliveries.map((d, i) => <div key={i} class={d.ok ? 'ok' : 'bad'}>{d.destination}: {d.detail}</div>)}
          <pre>{JSON.stringify({ ...ev.envelope, whatsAppWebhookEntry: JSON.parse(ev.envelope.whatsAppWebhookEntry) }, null, 2)}</pre>
        </details>
      ))}
    </aside>
  )
}
```

`ui/src/Templates.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks'
import { api, errorText, type Template, type Waba } from './api.ts'

export function Templates({ wabas, tick, onError }: { wabas: Waba[]; tick: number; onError: (e: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  useEffect(() => {
    api.templates().then((r) => setTemplates(r.templates)).catch((e) => onError(errorText(e)))
  }, [tick])
  const wabaName = (id: string) => wabas.find((w) => w.id === id)?.name ?? id
  const act = (p: Promise<unknown>) => p.catch((e) => onError(errorText(e)))

  return (
    <section class="page">
      <h2>Templates</h2>
      <table>
        <thead><tr><th>WABA</th><th>Name</th><th>Language</th><th>Category</th><th>Status</th><th>Body</th><th /></tr></thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.metaTemplateId}>
              <td>{wabaName(t.wabaId)}</td>
              <td>{t.name}<div class="small muted">{t.metaTemplateId}</div></td>
              <td>{t.language}</td>
              <td>{t.category}</td>
              <td><span class={`badge ${t.status.toLowerCase()}`}>{t.status}</span></td>
              <td class="body">{t.components.find((c) => String(c.type).toUpperCase() === 'BODY')?.text}</td>
              <td class="actions">
                {t.status !== 'APPROVED' && <button onClick={() => act(api.approve(t.metaTemplateId))}>Approve</button>}
                {t.status !== 'REJECTED' && (
                  <button class="danger" onClick={() => act(api.reject(t.metaTemplateId, prompt('Rejection reason', 'INVALID_FORMAT') ?? 'INVALID_FORMAT'))}>Reject</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

`ui/src/Events.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks'
import { api, type EventRow } from './api.ts'

function summary(e: EventRow): string {
  const v = JSON.parse(e.envelope.whatsAppWebhookEntry).changes[0].value
  if (v.statuses) return `${v.statuses[0].status} → ${v.statuses[0].recipient_id}${v.statuses[0].errors ? ` (${v.statuses[0].errors[0].code})` : ''}`
  if (v.messages) return `inbound ${v.messages[0].type} from ${v.messages[0].from}`
  return `${v.event} ${v.message_template_name}`
}

export function Events({ tick }: { tick: number }) {
  const [events, setEvents] = useState<EventRow[]>([])
  useEffect(() => {
    api.events().then((r) => setEvents(r.events)).catch(() => {})
  }, [tick])
  return (
    <section class="page">
      <h2>Events</h2>
      <table>
        <thead><tr><th>Time</th><th>Kind</th><th>Summary</th><th>Delivery</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.at).toLocaleTimeString()}</td>
              <td>{e.kind}</td>
              <td>{summary(e)}</td>
              <td>{e.deliveries.length === 0 ? <span class="muted">no destinations</span> : e.deliveries.map((d, i) => <div key={i} class={d.ok ? 'ok' : 'bad'}>{d.destination}: {d.detail}</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

`ui/src/styles.css`:
```css
:root {
  --bg: #f6f7f9; --panel: #ffffff; --border: #dfe3e8; --text: #1c2430; --muted: #6b7684;
  --accent: #128c7e; --accent-soft: #e6f4f1; --out: #dcf8c6; --in: #ffffff; --danger: #c0392b; --ok: #1e8e3e; --read: #34b7f1;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1418; --panel: #182026; --border: #2a343c; --text: #e6edf3; --muted: #8b98a5; --accent: #25d366; --accent-soft: #10302a; --out: #054740; --in: #1f2a31; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.danger { color: var(--danger); }
input, select { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; width: 100%; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; overflow: auto; max-height: 320px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app { display: flex; flex-direction: column; height: 100vh; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.topbar nav { display: flex; gap: 4px; margin-left: auto; }
.tab { text-transform: capitalize; border-color: transparent; }
.tab.active { background: var(--accent-soft); border-color: var(--accent); }
.error { background: var(--danger); color: #fff; padding: 6px 16px; cursor: pointer; }
.inbox { flex: 1; display: grid; grid-template-columns: 280px 1fr 360px; min-height: 0; }
.sidebar, .inspector { overflow: auto; padding: 12px; background: var(--panel); border-right: 1px solid var(--border); }
.inspector { border-right: 0; border-left: 1px solid var(--border); }
.empty { display: flex; align-items: center; justify-content: center; color: var(--muted); padding: 24px; text-align: center; }
.sidebar h3 { font-size: 13px; margin: 8px 0; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); }
.badge.pending { background: #fff4ce; color: #8a6d00; }
.badge.rejected { background: #fde2e1; color: var(--danger); }
.phone { margin: 0 0 12px 8px; }
.phone-head { font-weight: 600; }
.thread { display: flex; flex-direction: column; align-items: flex-start; width: 100%; margin-top: 4px; text-align: left; border-color: transparent; }
.thread.active { background: var(--accent-soft); border-color: var(--accent); }
.thread .ellipsis { max-width: 100%; }
.new-thread { display: grid; gap: 6px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.new-thread h4 { margin: 0; }
.thread-view { display: flex; flex-direction: column; min-height: 0; }
.thread-head { padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); font-weight: 600; }
.bubbles { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: 70%; text-align: left; border-radius: 10px; padding: 6px 10px; border: 1px solid var(--border); }
.bubble.out { align-self: flex-end; background: var(--out); }
.bubble.in { align-self: flex-start; background: var(--in); }
.bubble.selected { outline: 2px solid var(--accent); }
.bubble img { max-width: 220px; border-radius: 6px; display: block; margin-bottom: 4px; }
.bubble .tag { font-size: 11px; color: var(--muted); }
.bubble .text { white-space: pre-wrap; }
.bubble .meta { font-size: 11px; color: var(--muted); text-align: right; }
.tick.read { color: var(--read); }
.tick.failed { color: var(--danger); }
.composer { display: flex; gap: 6px; padding: 10px 16px; background: var(--panel); border-top: 1px solid var(--border); }
.composer .file { display: flex; align-items: center; gap: 4px; cursor: pointer; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; }
.composer .file input { display: none; }
.inspector dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 8px; margin: 0; }
.inspector dd { margin: 0; word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.actions select { width: auto; }
.ok { color: var(--ok); font-size: 12px; }
.bad { color: var(--danger); font-size: 12px; }
.page { padding: 16px; overflow: auto; }
table { width: 100%; border-collapse: collapse; background: var(--panel); }
th, td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
td.body { max-width: 420px; }
@media (max-width: 900px) { .inbox { grid-template-columns: 1fr; } .sidebar, .inspector { max-height: 40vh; } }
```

- [ ] **Step 7: Build the UI and run all tests**

Run: `npm run ui:build && npx vitest run && npx tsc --noEmit`
Expected: Vite writes `ui/dist/index.html`; all tests PASS (the UI test now sees `<div id="app">`); tsc clean.

- [ ] **Step 8: Manual smoke test**

Run the server without LocalStack (strip the `aws:` block from the example config):
```bash
sed '/^aws:/,/^$/d' eum-social-local-emulator.example.yaml > /tmp/eum-noaws.yaml
EUM_CONFIG=/tmp/eum-noaws.yaml EUM_DB=:memory: npm start
```
Expected: banner prints the SDK endpoint, inbox URL, "22 simulated, 16 routed but not simulated" and the WABA/phone ids. Open `http://localhost:4580/_eum/ui/`, use "Message as a customer", reply STOP, check the Events tab, then stop with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add ui src/api/ui.ts src/main.ts src/server.ts test/api/ui.test.ts
git commit -m "feat: WhatsApp inbox UI and CLI entry point"
```

---

### Task 15: Packaging, LocalStack end-to-end, Java smoke test, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `docker/localstack-init/10-eum.sh`, `test/e2e/localstack.test.ts`, `test/java/pom.xml`, `test/java/src/main/java/Smoke.java`, `README.md`

**Interfaces:**
- Consumes: `buildApp` (Task 8+), `parseConfig` (Task 4), `RealClock` (Task 5), `TEST_SEED`-style seed
- Produces: a runnable image `eum-social-local-emulator`, an opt-in e2e suite, an opt-in Java smoke test

- [ ] **Step 1: Write the end-to-end test**

`test/e2e/localstack.test.ts`:
```ts
import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging'
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns'
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { phoneAwsId } from '../../src/domain/ids.ts'
import { buildApp, type App } from '../../src/server.ts'

const LS = process.env.EUM_E2E_LOCALSTACK ?? 'http://localhost:4566'
const up = await fetch(`${LS}/_localstack/health`).then((r) => r.ok).catch(() => false)
const aws = { endpoint: LS, region: 'ap-south-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }

describe.skipIf(!up)(`end to end with LocalStack at ${LS}`, () => {
  const sqs = new SQSClient(aws)
  let app: App
  let queueUrl: string
  let client: SocialMessagingClient

  beforeAll(async () => {
    const suffix = Date.now()
    const sns = new SNSClient(aws)
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `eum-e2e-${suffix}` }))
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `eum-e2e-${suffix}` }))).QueueUrl!
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }))
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: Attributes!.QueueArn, Attributes: { RawMessageDelivery: 'true' } }))

    const config = {
      ...parseConfig(undefined, { EUM_AWS_ENDPOINT: LS }),
      dbPath: ':memory:',
      sim: { defaultFlow: ['sent' as const, 'delivered' as const, 'read' as const], stepDelayMs: 100, rules: [] },
      wabas: [{ name: 'E2E', metaWabaId: '900000000000001', eventDestinations: [TopicArn!], phoneNumbers: [{ phoneNumber: '+919800000009', displayName: 'E2E', metaPhoneNumberId: '900000000000002' }] }],
    }
    app = await buildApp({ config, logger: false })
    const url = await app.fastify.listen({ port: 0, host: '127.0.0.1' })
    client = new SocialMessagingClient({ ...aws, endpoint: url, maxAttempts: 1 })
  })

  afterAll(async () => { client?.destroy(); await app?.close() })

  async function drain(count: number): Promise<any[]> {
    const got: any[] = []
    const deadline = Date.now() + 20_000
    while (got.length < count && Date.now() < deadline) {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }))
      for (const m of r.Messages ?? []) got.push(JSON.parse(m.Body!))
    }
    return got
  }

  it('delivers sent, delivered and read envelopes to SNS → SQS, then an inbound STOP', async () => {
    await client.send(new SendWhatsAppMessageCommand({
      originationPhoneNumberId: phoneAwsId('900000000000002'),
      metaApiVersion: 'v20.0',
      message: new TextEncoder().encode(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'hello' } })),
    }))
    // Free-form text outside the window fails with 131047: one event.
    const [failed] = await drain(1)
    expect(failed.context.MetaPhoneNumberIds[0].metaPhoneNumberId).toBe('900000000000002')
    expect(JSON.parse(failed.whatsAppWebhookEntry).changes[0].value.statuses[0]).toMatchObject({ status: 'failed', errors: [{ code: 131047 }] })

    await app.ctx.sim.inbound({ phoneNumberId: phoneAwsId('900000000000002'), from: '+15550001', type: 'text', text: 'STOP' })
    const [inbound] = await drain(1)
    expect(JSON.parse(inbound.whatsAppWebhookEntry).changes[0].value.messages[0].text.body).toBe('STOP')

    await client.send(new SendWhatsAppMessageCommand({
      originationPhoneNumberId: phoneAwsId('900000000000002'),
      metaApiVersion: 'v20.0',
      message: new TextEncoder().encode(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'now inside the window' } })),
    }))
    // Standard SQS does not guarantee order, so compare as a set.
    const statuses = (await drain(3)).map((e) => JSON.parse(e.whatsAppWebhookEntry).changes[0].value.statuses[0].status)
    expect([...statuses].sort()).toEqual(['delivered', 'read', 'sent'])
  })
})
```

- [ ] **Step 2: Packaging files**

`.dockerignore`:
```
node_modules
data
ui/dist
test
docs
.git
```

`Dockerfile`:
```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY ui ./ui
COPY tsconfig.json ./
RUN npm run ui:build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production EUM_DB=/data/eum-local.db EUM_CONFIG=/etc/eum-social-local-emulator/eum-social-local-emulator.yaml
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY models ./models
COPY --from=build /app/ui/dist ./ui/dist
COPY eum-social-local-emulator.example.yaml /etc/eum-social-local-emulator/eum-social-local-emulator.yaml
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4580
VOLUME /data
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4580/_eum/health || exit 1
CMD ["node", "src/main.ts"]
```

`docker/localstack-init/10-eum.sh`:
```bash
#!/bin/bash
# Creates the example WhatsApp event topic and a queue subscribed to it, for eyeballing events.
set -euo pipefail
REGION=ap-south-1
TOPIC_ARN=$(awslocal sns create-topic --region "$REGION" --name eum-whatsapp-events --query TopicArn --output text)
QUEUE_URL=$(awslocal sqs create-queue --region "$REGION" --queue-name eum-whatsapp-events --query QueueUrl --output text)
QUEUE_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sns subscribe --region "$REGION" --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN" --attributes RawMessageDelivery=true
awslocal s3 mb s3://eum-media --region "$REGION" || true
echo "eum-social-local-emulator: topic $TOPIC_ARN -> queue $QUEUE_URL"
```

`docker-compose.example.yml`:
```yaml
# eum-social-local-emulator + LocalStack. Events land in the eum-whatsapp-events SQS queue.
services:
  localstack:
    image: localstack/localstack:4.11.1
    ports: ["4566:4566"]
    environment:
      SERVICES: sns,sqs,s3
      AWS_DEFAULT_REGION: ap-south-1
      ACTIVATE_PRO: 0
      LOCALSTACK_AUTH_TOKEN: ${LOCALSTACK_AUTH_TOKEN:-}
    volumes:
      - ./docker/localstack-init:/etc/localstack/init/ready.d:ro
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:4566/_localstack/health | grep -q '\"sns\": \"\\(running\\|available\\)\"'"]
      interval: 5s
      retries: 30

  eum-social-local-emulator:
    build: .
    ports: ["4580:4580"]
    environment:
      EUM_AWS_ENDPOINT: http://localstack:4566
    volumes:
      - ./eum-social-local-emulator.example.yaml:/etc/eum-social-local-emulator/eum-social-local-emulator.yaml:ro
      - eum-data:/data
    depends_on:
      localstack:
        condition: service_healthy

volumes:
  eum-data: {}
```

- [ ] **Step 3: Java smoke test**

`test/java/pom.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>local.eum</groupId>
  <artifactId>eum-social-local-emulator-java-smoke</artifactId>
  <version>1</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <!-- Same SDK version and transport as sample application -->
    <aws.sdk.version>2.46.7</aws.sdk.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>socialmessaging</artifactId>
      <version>${aws.sdk.version}</version>
    </dependency>
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>url-connection-client</artifactId>
      <version>${aws.sdk.version}</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>exec-maven-plugin</artifactId>
        <version>3.5.0</version>
        <configuration><mainClass>Smoke</mainClass></configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

`test/java/src/main/java/Smoke.java`:
```java
import java.net.URI;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.socialmessaging.SocialMessagingClient;
import software.amazon.awssdk.services.socialmessaging.model.GetLinkedWhatsAppBusinessAccountPhoneNumberRequest;
import software.amazon.awssdk.services.socialmessaging.model.ResourceNotFoundException;
import software.amazon.awssdk.services.socialmessaging.model.SendWhatsAppMessageRequest;

/** Usage: Smoke <endpoint> <phone-number-id>. Exits non-zero on any mismatch. */
public class Smoke {
  public static void main(String[] args) {
    String endpoint = args[0];
    String phoneId = args[1];
    try (SocialMessagingClient client = SocialMessagingClient.builder()
        .endpointOverride(URI.create(endpoint))
        .region(Region.AP_SOUTH_1)
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
        .httpClientBuilder(UrlConnectionHttpClient.builder())
        .build()) {

      var phone = client.getLinkedWhatsAppBusinessAccountPhoneNumber(
          GetLinkedWhatsAppBusinessAccountPhoneNumberRequest.builder().id(phoneId).build());
      System.out.println("phone: " + phone.phoneNumber().phoneNumber());

      String message = "{\"messaging_product\":\"whatsapp\",\"to\":\"+15550001\",\"type\":\"template\","
          + "\"template\":{\"name\":\"invoice_reminder\",\"language\":{\"code\":\"en\"},\"components\":[{\"type\":\"body\","
          + "\"parameters\":[{\"type\":\"text\",\"text\":\"Asha\"},{\"type\":\"text\",\"text\":\"INV-1\"},"
          + "{\"type\":\"text\",\"text\":\"Rs 100\"},{\"type\":\"text\",\"text\":\"Friday\"}]}]}}";
      var sent = client.sendWhatsAppMessage(SendWhatsAppMessageRequest.builder()
          .originationPhoneNumberId(phoneId)
          .message(SdkBytes.fromUtf8String(message))
          .metaApiVersion("v20.0")
          .build());
      System.out.println("messageId: " + sent.messageId());

      try {
        client.getLinkedWhatsAppBusinessAccountPhoneNumber(
            GetLinkedWhatsAppBusinessAccountPhoneNumberRequest.builder().id("phone-number-id-doesnotexist").build());
        throw new IllegalStateException("expected ResourceNotFoundException");
      } catch (ResourceNotFoundException expected) {
        System.out.println("error mapping: " + expected.getClass().getSimpleName());
      }
      System.out.println("JAVA SMOKE OK");
    }
  }
}
```

- [ ] **Step 4: README**

`README.md`:
````markdown
# eum-social-local-emulator

A local emulator for **AWS End User Messaging Social** (WhatsApp, service `socialmessaging`).
Point the real AWS SDK at it with an endpoint override. It accepts the current AWS API, behaves
like WhatsApp after the call returns (template approval, sent → delivered → read, Meta's delayed
failures, the 24-hour window, customer replies), and publishes the real EUM event envelope to
SNS on LocalStack. A browser inbox shows every message and lets you reply as the customer.

Design: [`docs/specs/2026-10-07-eum-social-local-emulator-design.md`](docs/specs/2026-10-07-eum-social-local-emulator-design.md)

## Quick start

```bash
npm install
npm run ui:build
cp eum-social-local-emulator.example.yaml eum-social-local-emulator.yaml   # edit WABAs, numbers, templates, rules
npm start                                  # http://localhost:4580
```

Open the inbox at <http://localhost:4580/_eum/ui/>. The startup banner prints each WABA and
phone-number id; ids derive from the Meta ids in the config, so they never change.

With Docker and LocalStack:

```bash
docker compose -f docker-compose.example.yml up --build
```

Events then arrive in the `eum-whatsapp-events` SQS queue:

```bash
aws --endpoint-url http://localhost:4566 --region ap-south-1 sqs receive-message \
  --queue-url http://localhost:4566/000000000000/eum-whatsapp-events
```

## Pointing an SDK at it

Any credentials work (the signature is not checked, but the request must be SigV4-signed).

**Java (SDK v2)** — configure the client endpoint as follows:

```java
SocialMessagingClient.builder()
    .endpointOverride(URI.create("http://localhost:4580"))
    .region(Region.AP_SOUTH_1)
    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
    .httpClientBuilder(UrlConnectionHttpClient.builder())
    .build();
```

Consumer applications can expose an optional endpoint setting and call
`.endpointOverride(...)` only when it is set.

**JavaScript (SDK v3)**:

```ts
new SocialMessagingClient({ endpoint: 'http://localhost:4580', region: 'ap-south-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
```

**Python (boto3)**:

```python
boto3.client('socialmessaging', endpoint_url='http://localhost:4580', region_name='ap-south-1',
             aws_access_key_id='test', aws_secret_access_key='test')
```

## What is emulated

`GET /_eum/api/coverage` lists it live. v1 simulates 22 of the model's 38 operations: WABA and
phone numbers, event destinations, `SendWhatsAppMessage`, templates (including the library and
header media), media upload/download, and tags. Flows, calling, datasets and the business public
key are routed and validated but return **501 `InternalServiceException`** ("not simulated yet").

After `SendWhatsAppMessage` returns, these Meta checks run and report back as a `failed` status
event, the way real WhatsApp does:

| Condition | Code |
|---|---|
| Template missing, not `APPROVED`, or wrong language | 132001 |
| Wrong number of body parameters | 132000 |
| Free-form message with no customer message in the last 24 h | 131047 |
| A `sim.rules` entry matches | the rule's code |

## Config reference (`eum-social-local-emulator.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `region`, `accountId` | `ap-south-1`, `000000000000` | Used in ARNs and the event envelope |
| `aws.endpoint` | none | LocalStack URL for the SNS sink and S3 media (`EUM_AWS_ENDPOINT`) |
| `webhookUrl` | none | Also POST every envelope here |
| `wabas[]` | `[]` | Seeded WABAs; `metaWabaId` and each `metaPhoneNumberId` are required |
| `templates.autoApproveSeconds` | `0` | Delay before `PENDING` → `APPROVED`; `-1` = approve by hand |
| `sim.defaultFlow` | `[sent, delivered, read]` | Status sequence for a successful send |
| `sim.stepDelayMs` | `1000` | Delay between statuses |
| `sim.rules[]` | `[]` | `{ match: { to, type, template }, outcome: { status: failed, code } \| { flow } }`; `to` is a glob |
| `messageIdMode` | `uuid` | `wamid` makes `SendWhatsAppMessage` return the wamid |

Environment: `EUM_CONFIG`, `EUM_PORT`, `EUM_HOST`, `EUM_DB` (`:memory:` for throwaway), `EUM_AWS_ENDPOINT`, `EUM_REGION`.

## Admin API

`/_eum/api`: `coverage`, `wabas` (GET/POST), `messages`, `messages/:wamid`,
`messages/:wamid/status` (POST `{status, code?}`), `inbound` (POST `{phoneNumberId, from, type, text?}`),
`templates`, `templates/:id/approve|reject`, `events`, `media/:id`, `stream` (SSE), `reset` (POST).

## Development

```bash
npm test                 # unit + contract tests through the real JS SDK
npm run test:e2e         # needs LocalStack on :4566 (skips otherwise)
npm run typecheck
npm run models:update    # pull the latest AWS model, then rerun the tests
mvn -q -f test/java/pom.xml compile exec:java -Dexec.args="http://localhost:4580 <phone-number-id>"
```

## Not emulated

SigV4 signature checks and IAM; SMS/Voice v2 and Push; Amazon Connect destinations; SNS retries;
Meta rate limits, quality ratings and messaging tiers. Not for production or load testing, and
the admin API has no auth, so do not expose the port beyond your machine.
````

- [ ] **Step 5: Run the opt-in suites**

Run:
```bash
npx vitest run && npx tsc --noEmit
docker compose -f docker-compose.example.yml up -d localstack && npm run test:e2e
```
Expected: unit/contract suites PASS; the e2e suite PASSes against LocalStack (or reports "skipped" if LocalStack is not reachable — then say so, do not claim it passed).

Then the Java smoke test against a running server:
```bash
sed '/^aws:/,/^$/d' eum-social-local-emulator.example.yaml > /tmp/eum-noaws.yaml
EUM_CONFIG=/tmp/eum-noaws.yaml EUM_DB=:memory: node src/main.ts &   # note the phone-number id in the banner
mvn -q -f test/java/pom.xml compile exec:java -Dexec.args="http://localhost:4580 <phone-number-id from banner>"
kill %1
```
Expected: prints `JAVA SMOKE OK`.

- [ ] **Step 6: Docker image check**

Run: `docker build -t eum-social-local-emulator . && docker run --rm -d -p 4581:4580 --name eum-smoke eum-social-local-emulator && sleep 3 && curl -fsS http://localhost:4581/_eum/health; docker rm -f eum-smoke`
Expected: `{"status":"ok"}`.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.example.yml docker README.md test/e2e test/java
git commit -m "feat: Docker packaging, LocalStack e2e, Java smoke test and README"
```
