import type { HandlerMap } from '../../context.ts'
import { tagHandlers } from './tags.ts'
import { wabaHandlers } from './waba.ts'
import { templateHandlers } from './templates.ts'
import { sendHandlers } from './send.ts'
// Each simulated area contributes handlers here; remaining operations return 501.
export function socialMessagingHandlers(): HandlerMap { return { ...wabaHandlers, ...tagHandlers, ...templateHandlers, ...sendHandlers } }
