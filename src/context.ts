import type { BlobStore } from './aws/blobStore.ts'
import type { Config } from './config.ts'
import type { EventBus } from './events/bus.ts'
import type { Clock } from './sim/clock.ts'
import type { Simulator } from './sim/simulator.ts'
import type { SmithyModel } from './smithy/model.ts'
import type { Db } from './store/db.ts'
export interface Ctx { config: Config; db: Db; clock: Clock; bus: EventBus; sim: Simulator; blobStore: BlobStore; model: SmithyModel }
export type Handler = (input: any, ctx: Ctx) => unknown | Promise<unknown>
export type HandlerMap = Record<string, Handler>
