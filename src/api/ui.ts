import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

export async function registerUi(app: FastifyInstance): Promise<void> {
  const root = fileURLToPath(new URL('../../ui/dist/', import.meta.url))
  app.get('/', (_request, reply) => reply.redirect('/_eum/ui/'))
  app.get('/_eum/ui', (_request, reply) => reply.redirect('/_eum/ui/'))
  if (!existsSync(`${root}index.html`)) {
    const hint = (_request: unknown, reply: { type(value: string): { send(value: string): unknown } }) => reply.type('text/plain').send('The eum-local inbox is not built yet. Run: npm run ui:build')
    app.get('/_eum/ui/', hint)
    app.get('/_eum/ui/*', hint)
    return
  }
  await app.register(fastifyStatic, { root, prefix: '/_eum/ui/' })
}
