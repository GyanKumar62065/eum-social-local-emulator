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
