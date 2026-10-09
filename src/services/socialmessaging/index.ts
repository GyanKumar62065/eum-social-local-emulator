import type { HandlerMap } from '../../context.ts'
import { tagHandlers } from './tags.ts'
import { wabaHandlers } from './waba.ts'
// Each simulated area contributes handlers here; remaining operations return 501.
export function socialMessagingHandlers(): HandlerMap { return { ...wabaHandlers, ...tagHandlers } }
