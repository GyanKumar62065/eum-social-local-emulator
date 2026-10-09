import type { Config, WabaSeed } from '../config.ts'
import { metaNumericId, phoneArn, phoneAwsId, wabaArn, wabaAwsId } from '../domain/ids.ts'
import type { Db } from './db.ts'
import { insertTemplate } from './templates.ts'
import type { RegistrationStatus, TemplateRow, WabaRow } from './types.ts'
import { getWabaByMeta, insertPhone, insertWaba } from './wabas.ts'

export function createWaba(db: Db, cfg: { region: string; accountId: string }, seed: WabaSeed, now: number, status: RegistrationStatus = 'COMPLETE'): WabaRow {
  const metaWabaId = seed.metaWabaId ?? metaNumericId()
  const id = wabaAwsId(metaWabaId)
  const waba: WabaRow = {
    id, arn: wabaArn(cfg.region, cfg.accountId, id), metaWabaId, name: seed.name,
    registrationStatus: status, linkDate: now,
    eventDestinations: (seed.eventDestinations ?? []).map((eventDestinationArn) => ({ eventDestinationArn })),
  }
  insertWaba(db, waba)
  for (const phone of seed.phoneNumbers ?? []) {
    const metaPhoneNumberId = phone.metaPhoneNumberId ?? metaNumericId()
    const phoneId = phoneAwsId(metaPhoneNumberId)
    insertPhone(db, {
      id: phoneId, arn: phoneArn(cfg.region, cfg.accountId, phoneId), wabaId: id, metaPhoneNumberId,
      phoneNumber: phone.phoneNumber, displayPhoneNumber: phone.phoneNumber, displayName: phone.displayName,
      qualityRating: phone.qualityRating ?? 'GREEN', dataLocalizationRegion: phone.dataLocalizationRegion,
    })
  }
  for (const template of seed.templates ?? []) {
    insertTemplate(db, {
      metaTemplateId: metaNumericId(), wabaId: id, name: template.name, language: template.language,
      category: template.category.toUpperCase(), status: template.status ?? 'APPROVED',
      parameterFormat: (template.parameterFormat ?? 'POSITIONAL').toUpperCase(), components: template.components as TemplateRow['components'],
      createdAt: now, updatedAt: now,
    })
  }
  return waba
}

export function seedFromConfig(db: Db, config: Config, now: number): void {
  for (const seed of config.wabas) {
    if (seed.metaWabaId && getWabaByMeta(db, seed.metaWabaId)) continue
    createWaba(db, config, seed, now)
  }
}
