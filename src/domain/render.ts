import type { TemplateRow } from '../store/types.ts'
import { renderTemplate } from './templates.ts'
const MEDIA = new Set(['image', 'document', 'video', 'audio', 'sticker'])
export function renderOutbound(body: any, template: TemplateRow | undefined): string {
  const type = String(body?.type)
  if (type === 'text') return String(body.text?.body ?? '')
  if (type === 'template') return template ? renderTemplate(template, body.template) : `[template ${body.template?.name}/${body.template?.language?.code} not found]`
  if (MEDIA.has(type)) return `[${type}] ${body[type]?.caption ?? body[type]?.filename ?? ''}`.trim()
  if (type === 'reaction') return `reacted ${body.reaction?.emoji ?? ''}`.trim()
  if (type === 'interactive') return String(body.interactive?.body?.text ?? '[interactive]')
  return `[${type}]`
}
