import type { Operation, SmithyModel } from './model.ts'

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function bindInput(model: SmithyModel, op: Operation, query: URLSearchParams, body: unknown): Record<string, unknown> {
  const shape = model.shape(op.input)
  const fromBody = isObj(body) ? body : {}
  const input: Record<string, unknown> = {}
  for (const [name, member] of Object.entries(shape.members ?? {})) {
    const queryName = member.traits?.['smithy.api#httpQuery'] as string | undefined
    if (queryName !== undefined) {
      const value = fromQuery(model, member.target, query.getAll(queryName))
      if (value !== undefined) input[name] = value
    } else if (fromBody[name] !== undefined && fromBody[name] !== null) {
      input[name] = fromJson(model, member.target, fromBody[name])
    }
  }
  return input
}

function fromQuery(model: SmithyModel, target: string, raw: string[]): unknown {
  if (raw.length === 0) return undefined
  const shape = model.shape(target)
  if (shape.type === 'list') return raw.map((value) => scalar(model, shape.member!.target, value))
  return scalar(model, target, raw[0])
}

function scalar(model: SmithyModel, target: string, raw: string): unknown {
  switch (model.shape(target).type) {
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : raw
    case 'integer':
    case 'long':
    case 'float':
    case 'double': {
      const number = Number(raw)
      return raw.trim() === '' || Number.isNaN(number) ? raw : number
    }
    case 'timestamp': return new Date(raw)
    default: return raw
  }
}

export function fromJson(model: SmithyModel, target: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  const shape = model.shape(target)
  switch (shape.type) {
    case 'blob': return typeof value === 'string' ? Buffer.from(value, 'base64') : value
    case 'timestamp': return typeof value === 'number' ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : value
    case 'list': return Array.isArray(value) ? value.map((item) => fromJson(model, shape.member!.target, item)) : value
    case 'map': return isObj(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromJson(model, shape.value!.target, item)])) : value
    case 'structure': {
      if (!isObj(value)) return value
      const output: Record<string, unknown> = {}
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        const item = fromJson(model, member.target, value[name])
        if (item !== undefined) output[name] = item
      }
      return output
    }
    default: return value
  }
}

export function toJson(model: SmithyModel, target: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  const shape = model.shape(target)
  switch (shape.type) {
    case 'blob': return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
    case 'timestamp': return value instanceof Date ? value.getTime() / 1000 : value
    case 'list': return Array.isArray(value) ? value.map((item) => toJson(model, shape.member!.target, item)) : value
    case 'map': return isObj(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(model, shape.value!.target, item)])) : value
    case 'structure': {
      if (!isObj(value)) return value
      const output: Record<string, unknown> = {}
      for (const [name, member] of Object.entries(shape.members ?? {})) {
        const item = toJson(model, member.target, value[name])
        if (item !== undefined) output[name] = item
      }
      return output
    }
    default: return value
  }
}
