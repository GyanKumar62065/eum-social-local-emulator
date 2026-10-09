import type { TemplateComponent, TemplateRow } from '../store/types.ts'
import { metaError, type MetaError } from './metaErrors.ts'

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
export function placeholders(text: string): string[] { return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))] }
export const bodyText = (components: TemplateComponent[]): string | undefined => components.find((component) => String(component.type).toUpperCase() === 'BODY')?.text

const valueOf = (parameter: any): string => String(parameter?.text ?? parameter?.currency?.fallback_value ?? parameter?.date_time?.fallback_value ?? parameter?.action?.code ?? parameter?.action ?? `[${parameter?.type ?? 'parameter'}]`)
export function suppliedParams(sendTemplate: any): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = []; const named: Record<string, string> = {}
  const body = (sendTemplate?.components ?? []).find((component: any) => String(component?.type).toLowerCase() === 'body')
  for (const param of body?.parameters ?? []) {
    const value = valueOf(param)
    if (param?.parameter_name) named[param.parameter_name] = value
    else positional.push(value)
  }
  return { positional, named }
}

function sendComponent(sendTemplate: any, type: string, index?: number): any {
  return (sendTemplate?.components ?? []).find((component: any) => String(component?.type).toUpperCase() === type.toUpperCase() && (index === undefined || Number(component?.index ?? 0) === index))
}
function parametersFor(component: any): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = []; const named: Record<string, string> = {}
  for (const parameter of component?.parameters ?? []) {
    const value = valueOf(parameter)
    if (parameter?.parameter_name) named[parameter.parameter_name] = value
    else positional.push(value)
  }
  return { positional, named }
}
function replaceParameters(text: string, supplied: { positional: string[]; named: Record<string, string> }): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => /^\d+$/.test(key) ? (supplied.positional[Number(key) - 1] ?? whole) : (supplied.named[key] ?? whole))
}
function formatText(templateComponent: TemplateComponent, sendTemplate: any): string {
  const type = String(templateComponent.type).toUpperCase()
  return replaceParameters(String(templateComponent.text ?? ''), parametersFor(sendComponent(sendTemplate, type)))
}
function appendButtons(lines: string[], component: TemplateComponent, sendTemplate: any): void {
  const buttons = Array.isArray(component.buttons) ? component.buttons as Record<string, any>[] : []
  buttons.forEach((button, index) => {
    const buttonComponent = sendComponent(sendTemplate, 'BUTTON', index)
    const params = parametersFor(buttonComponent)
    const parameter = params.positional[0] ?? Object.values(params.named)[0]
    const label = String(button.text ?? button.otp_type ?? button.type ?? 'Button')
    const urlTemplate = String(button.url ?? '')
    const url = replaceParameters(urlTemplate, params)
    lines.push(`${label}${urlTemplate ? `: ${url}` : parameter ? `: ${parameter}` : ''}`)
  })
}
export function renderTemplate(template: TemplateRow, sendTemplate: any): string {
  const lines: string[] = []
  for (const component of template.components) {
    const type = String(component.type).toUpperCase()
    if (['HEADER', 'BODY', 'FOOTER'].includes(type) && component.text) lines.push(formatText(component, sendTemplate))
    if (type === 'AUTHENTICATION') {
      const body = sendComponent(sendTemplate, 'BODY')
      const code = parametersFor(body).positional[0] ?? Object.values(parametersFor(body).named)[0]
      lines.push(code ? `Authentication code: ${code}` : 'Authentication code')
      if (component.add_security_recommendation) lines.push('For your security, do not share this code.')
      if (component.code_expiration_minutes !== undefined) lines.push(`This code expires in ${String(component.code_expiration_minutes)} minutes.`)
      appendButtons(lines, component, sendTemplate)
    }
    if (type === 'BUTTONS') appendButtons(lines, component, sendTemplate)
  }
  return lines.join('\n') || `[template ${template.name}/${template.language}]`
}

function matches(text: string, send: any, parameterFormat: string): boolean {
  const expected = placeholders(text)
  const provided = parametersFor(send)
  if (parameterFormat === 'NAMED') return expected.every((key) => Object.hasOwn(provided.named, key)) && Object.keys(provided.named).length === expected.length
  const expectedPositions = expected.filter((key) => /^\d+$/.test(key)).map(Number)
  return provided.positional.length === Math.max(0, ...expectedPositions)
}
export function checkTemplateSend(template: TemplateRow | undefined, body: any): MetaError | null {
  if (!template || template.status !== 'APPROVED') return metaError(132001)
  const send = body?.template
  for (const component of template.components) {
    const type = String(component.type).toUpperCase()
    if (['HEADER', 'BODY', 'FOOTER'].includes(type) && component.text) {
      if (!matches(String(component.text), sendComponent(send, type), template.parameterFormat)) return metaError(132000)
    }
    if (type === 'BUTTONS') {
      const buttons = Array.isArray(component.buttons) ? component.buttons as Record<string, any>[] : []
      for (const [index, button] of buttons.entries()) {
        if (String(button.type).toUpperCase() !== 'URL') continue
        const url = String(button.url ?? '')
        const dynamicSuffix = url.slice(url.lastIndexOf('/') + 1)
        const expected = Math.max(0, ...placeholders(dynamicSuffix).filter((key) => /^\d+$/.test(key)).map(Number))
        const params = parametersFor(sendComponent(send, 'BUTTON', index))
        if (params.positional.length !== expected) return metaError(132000)
      }
    }
    if (type === 'AUTHENTICATION') {
      const buttons = (Array.isArray(component.buttons) ? component.buttons : []) as Record<string, any>[]
      const requiresAction = buttons.some((button) => String(button.type).toUpperCase() === 'OTP')
      const bodyParameters = parametersFor(sendComponent(send, 'BODY'))
      const buttonParameters = parametersFor(sendComponent(send, 'BUTTON'))
      if (requiresAction && bodyParameters.positional.length + Object.keys(bodyParameters.named).length + buttonParameters.positional.length + Object.keys(buttonParameters.named).length === 0) return metaError(132000)
    }
  }
  return null
}
export function validateTemplateName(name: unknown): string | null {
  return typeof name === 'string' && /^[a-z0-9_]{1,512}$/.test(name) ? null : 'Template name must be 1-512 characters of lowercase letters, digits and underscores'
}
