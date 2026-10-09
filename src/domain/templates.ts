import type { TemplateComponent, TemplateRow } from '../store/types.ts'
import { metaError, type MetaError } from './metaErrors.ts'

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
export function placeholders(text: string): string[] { return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))] }
export const bodyText = (components: TemplateComponent[]): string | undefined => components.find((component) => String(component.type).toUpperCase() === 'BODY')?.text
export function suppliedParams(sendTemplate: any): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = []; const named: Record<string, string> = {}
  const body = (sendTemplate?.components ?? []).find((component: any) => String(component?.type).toLowerCase() === 'body')
  for (const param of body?.parameters ?? []) {
    const value = String(param?.text ?? param?.currency?.fallback_value ?? param?.date_time?.fallback_value ?? `[${param?.type}]`)
    if (param?.parameter_name) named[param.parameter_name] = value
    else positional.push(value)
  }
  return { positional, named }
}
export function renderTemplate(template: TemplateRow, sendTemplate: any): string {
  const params = suppliedParams(sendTemplate)
  return (bodyText(template.components) ?? '').replace(PLACEHOLDER, (whole, key: string) => /^\d+$/.test(key) ? (params.positional[Number(key) - 1] ?? whole) : (params.named[key] ?? whole))
}
export function checkTemplateSend(template: TemplateRow | undefined, body: any): MetaError | null {
  if (!template || template.status !== 'APPROVED') return metaError(132001)
  const expected = placeholders(bodyText(template.components) ?? '').length
  const params = suppliedParams(body?.template)
  const supplied = template.parameterFormat === 'NAMED' ? Object.keys(params.named).length : params.positional.length
  return supplied === expected ? null : metaError(132000)
}
export function validateTemplateName(name: unknown): string | null {
  return typeof name === 'string' && /^[a-z0-9_]{1,512}$/.test(name) ? null : 'Template name must be 1-512 characters of lowercase letters, digits and underscores'
}
