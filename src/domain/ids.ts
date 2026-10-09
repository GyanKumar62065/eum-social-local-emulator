import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

const hex32 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
export const wabaAwsId = (metaId: string) => `waba-${hex32(`waba:${metaId}`)}`
export const phoneAwsId = (metaId: string) => `phone-number-id-${hex32(`phone:${metaId}`)}`
export const wabaArn = (region: string, account: string, id: string) => `arn:aws:social-messaging:${region}:${account}:waba/${id.slice('waba-'.length)}`
export const phoneArn = (region: string, account: string, id: string) => `arn:aws:social-messaging:${region}:${account}:phone-number-id/${id.slice('phone-number-id-'.length)}`
export function resolveId(idOrArn: string, kind: 'waba' | 'phone-number-id'): string {
  if (!idOrArn.startsWith('arn:')) return idOrArn
  const resourceId = idOrArn.slice(idOrArn.lastIndexOf('/') + 1)
  return `${kind}-${resourceId}`
}
export const metaNumericId = () => `${randomInt(1, 10)}${String(randomInt(0, 1e14)).padStart(14, '0')}`
export const newWamid = () => `wamid.${randomBytes(30).toString('base64').replace(/[+/=]/g, '')}`
export const newMessageId = () => randomUUID()
export function msisdn(raw: string): string { const digits = raw.replace(/\D/g, ''); return digits ? `+${digits}` : '' }
export const digits = (e164: string) => e164.replace(/\D/g, '')
