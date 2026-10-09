import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'

export const STATUS_NAMES = ['sent', 'delivered', 'read', 'failed'] as const
export type StatusName = (typeof STATUS_NAMES)[number]
export interface PhoneSeed { phoneNumber: string; displayName: string; metaPhoneNumberId?: string; qualityRating?: string; dataLocalizationRegion?: string }
export interface TemplateSeed { name: string; language: string; category: string; status?: string; parameterFormat?: string; components: Record<string, unknown>[] }
export interface WabaSeed { name: string; metaWabaId?: string; eventDestinations?: string[]; phoneNumbers?: PhoneSeed[]; templates?: TemplateSeed[] }
export interface SimRule { match: { to?: string; type?: string; template?: string }; outcome: { status?: 'failed'; code?: number; title?: string; flow?: StatusName[] } }
export interface Config {
  port: number; host: string; dbPath: string; region: string; accountId: string; aws?: { endpoint: string }; webhookUrl?: string
  wabas: WabaSeed[]; templates: { autoApproveSeconds: number }; sim: { defaultFlow: StatusName[]; stepDelayMs: number; rules: SimRule[] }; messageIdMode: 'uuid' | 'wamid'
}

export function parseConfig(text: string | undefined, env: Record<string, string | undefined>, source = '(defaults)'): Config {
  const fail = (message: string): never => { throw new Error(`eum-social-local-emulator config ${source}: ${message}`) }
  const raw: any = text ? (parse(text, { intAsBigInt: true }) ?? {}) : {}
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be a mapping')
  const flow = (value: unknown, where: string): StatusName[] => {
    if (!Array.isArray(value) || value.length === 0 || !value.every((status) => (STATUS_NAMES as readonly string[]).includes(status))) fail(`${where} must be a non-empty list of ${STATUS_NAMES.join('|')}`)
    return value as StatusName[]
  }
  const sim = raw.sim ?? {}
  const rules: SimRule[] = (sim.rules ?? []).map((rule: any, i: number) => {
    if (!rule?.match || !rule?.outcome) fail(`sim.rules[${i}] needs match and outcome`)
    if (rule.outcome.flow) flow(rule.outcome.flow, `sim.rules[${i}].outcome.flow`)
    if (rule.outcome.status !== undefined && rule.outcome.status !== 'failed') fail(`sim.rules[${i}].outcome.status can only be failed`)
    const code = rule.outcome.code === undefined ? undefined : Number(rule.outcome.code)
    if (code !== undefined && !Number.isSafeInteger(code)) fail(`sim.rules[${i}].outcome.code must be a safe integer`)
    return { ...rule, outcome: { ...rule.outcome, code } } as SimRule
  })
  const wabas: WabaSeed[] = (raw.wabas ?? []).map((waba: any, i: number) => {
    if (!waba?.name) fail(`wabas[${i}].name is required`)
    if (!/^\d+$/.test(String(waba.metaWabaId ?? ''))) fail(`wabas[${i}].metaWabaId is required (digits) so ids stay stable across restarts`)
    const phoneNumbers = (waba.phoneNumbers ?? []).map((phone: any, j: number) => {
      const at = `wabas[${i}].phoneNumbers[${j}]`
      if (!/^\+\d{8,15}$/.test(String(phone?.phoneNumber ?? ''))) fail(`${at}.phoneNumber must be E.164, e.g. +919800000001`)
      if (!phone.displayName) fail(`${at}.displayName is required`)
      if (!/^\d+$/.test(String(phone.metaPhoneNumberId ?? ''))) fail(`${at}.metaPhoneNumberId is required (digits)`)
      return { ...phone, metaPhoneNumberId: String(phone.metaPhoneNumberId) }
    })
    for (const [j, template] of (waba.templates ?? []).entries()) {
      if (!template?.name || !template.language || !template.category || !Array.isArray(template.components)) fail(`wabas[${i}].templates[${j}] needs name, language, category and components`)
    }
    return { ...waba, metaWabaId: String(waba.metaWabaId), phoneNumbers }
  })
  const messageIdMode = raw.messageIdMode ?? 'uuid'
  if (messageIdMode !== 'uuid' && messageIdMode !== 'wamid') fail('messageIdMode must be uuid or wamid')
  const awsEndpoint = env.EUM_AWS_ENDPOINT ?? raw.aws?.endpoint
  const port = Number(env.EUM_PORT ?? raw.port ?? 4580)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port must be an integer from 1 to 65535')
  return {
    port, host: env.EUM_HOST ?? raw.host ?? '0.0.0.0', dbPath: env.EUM_DB ?? raw.dbPath ?? './data/eum-local.db',
    region: env.EUM_REGION ?? raw.region ?? 'ap-south-1', accountId: String(raw.accountId ?? '000000000000'),
    aws: awsEndpoint ? { endpoint: awsEndpoint } : undefined, webhookUrl: raw.webhookUrl, wabas,
    templates: { autoApproveSeconds: Number(raw.templates?.autoApproveSeconds ?? 0) },
    sim: { defaultFlow: flow(sim.defaultFlow ?? ['sent', 'delivered', 'read'], 'sim.defaultFlow'), stepDelayMs: Number(sim.stepDelayMs ?? 1000), rules },
    messageIdMode,
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (env.EUM_CONFIG && !existsSync(env.EUM_CONFIG)) throw new Error(`eum-social-local-emulator config ${env.EUM_CONFIG}: file not found`)
  const path = env.EUM_CONFIG ?? (existsSync('eum-social-local-emulator.yaml') ? 'eum-social-local-emulator.yaml' : existsSync('eum-local.yaml') ? 'eum-local.yaml' : undefined)
  return parseConfig(path ? readFileSync(path, 'utf8') : undefined, env, path)
}
