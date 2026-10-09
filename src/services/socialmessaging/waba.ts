import { randomBytes } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId, resolveId } from '../../domain/ids.ts'
import { paginate } from '../../domain/paging.ts'
import { AwsError, invalid, notFound } from '../../smithy/errors.ts'
import { createWaba } from '../../store/seed.ts'
import { deleteTagsFor, putTags } from '../../store/tags.ts'
import type { PhoneRow, WabaRow } from '../../store/types.ts'
import { deleteWaba, getPhone, getWaba, getWabaByToken, listPhones, listWabas, updatePhoneCallSettings, updateWaba } from '../../store/wabas.ts'

export const phoneDetail = (phone: PhoneRow) => ({ arn: phone.arn, phoneNumber: phone.phoneNumber, phoneNumberId: phone.id, metaPhoneNumberId: phone.metaPhoneNumberId, displayPhoneNumberName: phone.displayName, displayPhoneNumber: phone.displayPhoneNumber, qualityRating: phone.qualityRating, dataLocalizationRegion: phone.dataLocalizationRegion })
const wabaSummary = (waba: WabaRow) => ({ arn: waba.arn, id: waba.id, wabaId: waba.metaWabaId, registrationStatus: waba.registrationStatus, linkDate: new Date(waba.linkDate), wabaName: waba.name, eventDestinations: waba.eventDestinations })
export function requireWaba(ctx: Ctx, idOrArn: string, missing: 'ResourceNotFoundException' | 'InvalidParametersException' = 'ResourceNotFoundException'): WabaRow {
  const waba = getWaba(ctx.db, resolveId(idOrArn, 'waba'))
  if (!waba) throw new AwsError(missing, `WhatsApp Business Account ${idOrArn} not found`)
  return waba
}
export function requirePhone(ctx: Ctx, idOrArn: string): { phone: PhoneRow; waba: WabaRow } {
  const phone = getPhone(ctx.db, resolveId(idOrArn, 'phone-number-id'))
  const waba = phone && getWaba(ctx.db, phone.wabaId)
  if (!phone || !waba) throw notFound(`Phone number ${idOrArn}`)
  return { phone, waba }
}

export const wabaHandlers: HandlerMap = {
  AssociateWhatsAppBusinessAccount(input, ctx) {
    if (input.signupCallback) {
      const metaWabaId = metaNumericId()
      const waba = createWaba(ctx.db, ctx.config, { name: `Signup ${metaWabaId}`, metaWabaId, phoneNumbers: [{ phoneNumber: `+1555${metaWabaId.slice(-7)}`, displayName: 'Signup Test Number', metaPhoneNumberId: metaNumericId() }] }, ctx.clock.now(), 'INCOMPLETE')
      const token = randomBytes(16).toString('hex')
      updateWaba(ctx.db, { ...waba, associateToken: token }); ctx.bus.notify({ type: 'waba' })
      return { statusCode: 200, signupCallbackResult: { associateInProgressToken: token, linkedAccountsWithIncompleteSetup: { [metaWabaId]: { accountName: waba.name, registrationStatus: 'INCOMPLETE', unregisteredWhatsAppPhoneNumbers: listPhones(ctx.db, waba.id).map(phoneDetail), wabaId: waba.id } } } }
    }
    if (input.setupFinalization) {
      const finalization = input.setupFinalization
      const waba = getWabaByToken(ctx.db, finalization.associateInProgressToken)
      if (!waba) throw invalid('associateInProgressToken is unknown or already used')
      if (finalization.waba?.id && finalization.waba.id !== waba.metaWabaId) throw invalid(`waba.id ${finalization.waba.id} does not match the signup in progress`)
      const phones = listPhones(ctx.db, waba.id)
      for (const seed of finalization.phoneNumbers) {
        const phone = phones.find((item) => item.metaPhoneNumberId === seed.id)
        if (!phone) throw invalid(`Phone number ${seed.id} is not part of this signup`)
        if (seed.tags) putTags(ctx.db, phone.arn, seed.tags)
      }
      updateWaba(ctx.db, { ...waba, registrationStatus: 'COMPLETE', associateToken: undefined, eventDestinations: finalization.waba?.eventDestinations ?? waba.eventDestinations })
      if (finalization.waba?.tags) putTags(ctx.db, waba.arn, finalization.waba.tags)
      ctx.bus.notify({ type: 'waba' })
      return { statusCode: 200, linkedWhatsAppBusinessAccountId: waba.id }
    }
    throw invalid('Provide signupCallback or setupFinalization')
  },
  DisassociateWhatsAppBusinessAccount(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    deleteTagsFor(ctx.db, [waba.arn, ...listPhones(ctx.db, waba.id).map((phone) => phone.arn)])
    deleteWaba(ctx.db, waba.id); ctx.bus.notify({ type: 'waba' }); return {}
  },
  GetLinkedWhatsAppBusinessAccount(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    return { account: { ...wabaSummary(waba), phoneNumbers: listPhones(ctx.db, waba.id).map(phoneDetail) } }
  },
  ListLinkedWhatsAppBusinessAccounts(input, ctx) {
    const page = paginate(listWabas(ctx.db).map(wabaSummary), input.nextToken, input.maxResults)
    return { linkedAccounts: page.items, nextToken: page.nextToken }
  },
  GetLinkedWhatsAppBusinessAccountPhoneNumber(input, ctx) {
    const { phone, waba } = requirePhone(ctx, input.id)
    return { phoneNumber: phoneDetail(phone), linkedWhatsAppBusinessAccountId: waba.id, callSettings: phone.callSettings }
  },
  UpdateLinkedWhatsAppBusinessAccountPhoneNumber(input, ctx) {
    const { phone } = requirePhone(ctx, input.id); updatePhoneCallSettings(ctx.db, phone.id, input.callSettings); return { phoneNumberId: phone.id }
  },
  PutWhatsAppBusinessAccountEventDestinations(input, ctx) {
    const waba = requireWaba(ctx, input.id, 'InvalidParametersException')
    updateWaba(ctx.db, { ...waba, eventDestinations: input.eventDestinations }); ctx.bus.notify({ type: 'waba' }); return {}
  },
}
