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
import { getTemplateById, listTemplates } from '../store/templates.ts'
import type { EventKind } from '../store/types.ts'
import { listPhones, listWabas } from '../store/wabas.ts'
import { coverage } from './aws.ts'

const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error })
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export function readModelSource(): Record<string, string> {
  const source = readFileSync(new URL('../../models/SOURCE', import.meta.url), 'utf8')
  return Object.fromEntries(source.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
}
function queryLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit must be an integer from 1 to 5000')
  return limit
}
export function registerAdminApi(app: FastifyInstance, ctx: Ctx, handlers: HandlerMap): void {
  const { db, sim, bus } = ctx; const prefix = '/_eum/api'
  app.get(`${prefix}/coverage`, async () => ({ model: readModelSource(), ...coverage(ctx.model, handlers) }))
  app.get(`${prefix}/wabas`, async () => ({ wabas: listWabas(db).map((waba) => ({ ...waba, phoneNumbers: listPhones(db, waba.id) })) }))
  app.post(`${prefix}/wabas`, async (request, reply) => {
    const seed = request.body as WabaSeed
    if (!seed?.name) return fail(reply, 400, 'name is required')
    try { const waba = createWaba(db, ctx.config, seed, ctx.clock.now()); bus.notify({ type: 'waba' }); return reply.code(201).send({ waba }) }
    catch (error) { return fail(reply, 400, errorText(error)) }
  })
  app.get(`${prefix}/messages`, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    try { return { messages: listMessages(db, { phoneNumberId: query.phoneNumberId, peer: query.peer, status: query.status, limit: queryLimit(query.limit) }) } }
    catch (error) { return fail(reply, 400, errorText(error)) }
  })
  app.get(`${prefix}/messages/:wamid`, async (request, reply) => {
    const { wamid } = request.params as { wamid: string }; const message = getMessage(db, wamid)
    if (!message) return fail(reply, 404, `message ${wamid} not found`)
    return { message, history: statusHistory(db, wamid), events: listEvents(db, { wamid }) }
  })
  app.post(`${prefix}/messages/:wamid/status`, async (request, reply) => {
    const { wamid } = request.params as { wamid: string }; const body = (request.body ?? {}) as { status?: string; code?: number; title?: string }
    if (!(STATUS_NAMES as readonly string[]).includes(body.status ?? '')) return fail(reply, 400, `status must be one of ${STATUS_NAMES.join(', ')}`)
    const status = body.status as StatusName
    if (status === 'failed' && body.code !== undefined && !Number.isSafeInteger(body.code)) return fail(reply, 400, 'code must be a safe integer')
    const message = await sim.applyStatus(wamid, status, status === 'failed' ? metaError(Number(body.code ?? 131026), body.title) : undefined)
    if (!message) return fail(reply, 404, `message ${wamid} not found`)
    return { message }
  })
  app.post(`${prefix}/inbound`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, any>
    if (!['text', 'button', 'image', 'interactive'].includes(body.type)) return fail(reply, 400, 'type must be text, button, image or interactive')
    try { return reply.code(201).send({ message: await sim.inbound(body as any) }) }
    catch (error) { const message = errorText(error); return fail(reply, message.startsWith('unknown phone number') ? 404 : 400, message) }
  })
  app.get(`${prefix}/templates`, async (request) => ({ templates: listTemplates(db, (request.query as { wabaId?: string }).wabaId) }))
  for (const [action, status] of [['approve', 'APPROVED'], ['reject', 'REJECTED'], ['pause', 'PAUSED'], ['disable', 'DISABLED']] as const) {
    app.post(`${prefix}/templates/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { reason?: string; generation?: number; expectedStatus?: string }
      if (body.generation !== undefined && (typeof body.generation !== 'number' || !Number.isSafeInteger(body.generation) || body.generation < 1)) return fail(reply, 400, 'generation must be a positive safe integer')
      const current = getTemplateById(db, id)
      if (!current) return fail(reply, 404, `template ${id} not found`)
      const generation = body.generation ?? current.generation
      if (generation === undefined) return fail(reply, 404, `template ${id} not found`)
      if (typeof body.expectedStatus !== 'string' || !body.expectedStatus) return fail(reply, 400, 'expectedStatus is required')
      try { return { template: await sim.setTemplateStatus(id, status, body.reason, generation, body.expectedStatus) } }
      catch (error) { const message = errorText(error); return fail(reply, message.includes('has changed') ? 409 : 404, message) }
    })
  }
  app.get(`${prefix}/events`, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    try { return { events: listEvents(db, { kind: query.kind as EventKind | undefined, wamid: query.wamid, limit: queryLimit(query.limit) }) } }
    catch (error) { return fail(reply, 400, errorText(error)) }
  })
  app.post(`${prefix}/events/:id/replay`, async (request, reply) => {
    const { id } = request.params as { id: string }; const body = (request.body ?? {}) as { destination?: string }
    if (!body.destination) return fail(reply, 400, 'destination is required')
    try { return { event: await bus.replay(id, body.destination, ctx.clock.now()) } }
    catch (error) { const message = errorText(error); return fail(reply, message.includes('not found') ? 404 : 400, message) }
  })
  app.get(`${prefix}/media/:id`, async (request, reply) => {
    const media = getMedia(db, (request.params as { id: string }).id)
    if (!media) return fail(reply, 404, 'media not found')
    return reply.type(media.mimeType).send(Buffer.from(media.bytes))
  })
  app.get(`${prefix}/stream`, (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    reply.raw.write(': connected\n\n')
    const unsubscribe = bus.subscribe((event) => reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    reply.raw.on('close', unsubscribe)
  })
  app.post(`${prefix}/reset`, async () => {
    ctx.clock.cancelAll(); resetDb(db); seedFromConfig(db, ctx.config, ctx.clock.now()); bus.notify({ type: 'reset' }); return { ok: true }
  })
}
