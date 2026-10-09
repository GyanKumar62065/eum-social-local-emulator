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

// Prelude shapes are referenced by service models but are not included in them.
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
    const service = Object.entries(this.shapes).find(([, shape]) => shape.type === 'service')
    if (!service) throw new Error('eum-social-local-emulator: model has no service shape')
    this.namespace = service[0].slice(0, service[0].indexOf('#'))
    const serviceErrors = (service[1].errors ?? []).map((error) => shortName(error.target))
    this.operations = new Map()
    for (const [id, shape] of Object.entries(this.shapes)) {
      const http = shape.traits?.['smithy.api#http']
      if (shape.type !== 'operation' || !http) continue
      const name = shortName(id)
      this.operations.set(name, {
        name,
        method: String(http.method).toUpperCase(),
        uri: String(http.uri),
        input: shape.input?.target ?? 'smithy.api#Unit',
        output: shape.output?.target ?? 'smithy.api#Unit',
        errors: [...(shape.errors ?? []).map((error) => shortName(error.target)), ...serviceErrors],
      })
    }
  }

  static load(path: string): SmithyModel {
    return new SmithyModel(JSON.parse(readFileSync(path, 'utf8')))
  }

  shape(id: string): Shape {
    const shape = this.shapes[id] ?? PRELUDE[id]
    if (!shape) throw new Error(`eum-social-local-emulator: unknown shape ${id}`)
    return shape
  }

  errorStatus(name: string): number {
    const shape = this.shapes[`${this.namespace}#${name}`]
    const status = shape?.traits?.['smithy.api#httpError']
    if (typeof status === 'number') return status
    return shape?.traits?.['smithy.api#error'] === 'server' ? 500 : 400
  }
}
