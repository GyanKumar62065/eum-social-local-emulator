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

export interface AppOptions { config: Config; clock?: Clock; sinks?: Sink[]; blobStore?: BlobStore; logger?: boolean }
export interface App { fastify: FastifyInstance; ctx: Ctx; model: SmithyModel; handlers: HandlerMap; close(): Promise<void> }
export async function buildApp(options: AppOptions): Promise<App> {
  const { config } = options
  const fastify = Fastify({ logger: options.logger ?? true, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true })
  const model = SmithyModel.load(MODEL_PATH)
  const db = openDb(config.dbPath)
  const clock = options.clock ?? new RealClock()
  seedFromConfig(db, config, clock.now())
  const sinks = options.sinks ?? (config.aws ? [snsSink(config.aws.endpoint, config.region)] : [])
  const bus = new EventBus({ db, sinks, accountId: config.accountId, webhookUrl: config.webhookUrl, log: fastify.log })
  const sim = new Simulator({ db, clock, bus, config })
  const blobStore = options.blobStore ?? (config.aws ? s3BlobStore(config.aws.endpoint, config.region) : noBlobStore())
  const ctx: Ctx = { config, db, clock, bus, sim, blobStore, model }
  const handlers = socialMessagingHandlers()
  registerAwsApi(fastify, model, handlers, ctx)
  fastify.get('/_eum/health', async () => ({ status: 'ok' }))
  sim.resumePendingTemplates()
  return {
    fastify, ctx, model, handlers,
    close: async () => { clock.cancelAll(); await fastify.close(); db.close() },
  }
}
