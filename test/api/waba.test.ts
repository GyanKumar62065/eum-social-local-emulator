import { AssociateWhatsAppBusinessAccountCommand, DisassociateWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, ListLinkedWhatsAppBusinessAccountsCommand, ListTagsForResourceCommand, PutWhatsAppBusinessAccountEventDestinationsCommand, TagResourceCommand, UntagResourceCommand, UpdateLinkedWhatsAppBusinessAccountPhoneNumberCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMessage, insertMessage } from '../../src/store/messages.ts'
import { PHONE_ID, startHarness, TEST_TOPIC, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })
describe('WABA operations', () => {
  it('lists and gets the seeded WABA with its phone numbers', async () => {
    const list = await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({})); expect(list.linkedAccounts).toHaveLength(1)
    expect(list.linkedAccounts![0]).toMatchObject({ id: WABA_ID, wabaId: '100000000000001', registrationStatus: 'COMPLETE', wabaName: 'Example Business', eventDestinations: [{ eventDestinationArn: TEST_TOPIC }] }); expect(list.linkedAccounts![0].linkDate).toBeInstanceOf(Date)
    const got = await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: list.linkedAccounts![0].arn! }))
    expect(got.account?.phoneNumbers).toEqual([expect.objectContaining({ phoneNumberId: PHONE_ID, phoneNumber: '+919800000001', metaPhoneNumberId: '200000000000001', qualityRating: 'GREEN' })])
  })
  it('paginates the account list', async () => { const page = await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({ maxResults: 1 })); expect(page.linkedAccounts).toHaveLength(1); expect(page.nextToken).toBeUndefined() })
  it('gets and updates a phone number', async () => {
    const got = await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID })); expect(got).toMatchObject({ linkedWhatsAppBusinessAccountId: WABA_ID, phoneNumber: { displayPhoneNumberName: 'Example Sender' } })
    const updated = await h.client.send(new UpdateLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID, callSettings: { callEnabled: true } })); expect(updated.phoneNumberId).toBe(PHONE_ID)
    expect((await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))).callSettings).toEqual({ callEnabled: true })
  })
  it('returns ResourceNotFoundException for unknown ids', async () => { const error = await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: 'waba-doesnotexist' })).catch((caught) => caught); expect(error.name).toBe('ResourceNotFoundException') })
  it('replaces event destinations; unknown WABA is InvalidParametersException', async () => {
    const arn = 'arn:aws:sns:ap-south-1:000000000000:other'
    await h.client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id: WABA_ID, eventDestinations: [{ eventDestinationArn: arn }] }))
    expect((await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: WABA_ID }))).account?.eventDestinations).toEqual([{ eventDestinationArn: arn }])
    const error = await h.client.send(new PutWhatsAppBusinessAccountEventDestinationsCommand({ id: 'waba-x', eventDestinations: [] })).catch((caught) => caught); expect(error.name).toBe('InvalidParametersException')
  })
  it('runs the two-step signup: callback then finalization', async () => {
    const callback = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({ signupCallback: { accessToken: 'meta-token' } }))
    const token = callback.signupCallbackResult!.associateInProgressToken!; const [metaWabaId, pending] = Object.entries(callback.signupCallbackResult!.linkedAccountsWithIncompleteSetup!)[0]
    expect(pending.registrationStatus).toBe('INCOMPLETE'); const phone = pending.unregisteredWhatsAppPhoneNumbers![0]
    const final = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({ setupFinalization: { associateInProgressToken: token, phoneNumbers: [{ id: phone.metaPhoneNumberId!, twoFactorPin: '123456' }], waba: { id: metaWabaId, eventDestinations: [{ eventDestinationArn: TEST_TOPIC }] } } }))
    expect(final.linkedWhatsAppBusinessAccountId).toBe(pending.wabaId); expect((await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: final.linkedWhatsAppBusinessAccountId! }))).account?.registrationStatus).toBe('COMPLETE')
    const again = await h.client.send(new AssociateWhatsAppBusinessAccountCommand({ setupFinalization: { associateInProgressToken: token, phoneNumbers: [] } })).catch((caught) => caught); expect(again.name).toBe('InvalidParametersException')
  })
  it('disassociates a WABA, dropping its phones and messages (Review Focus 2)', async () => {
    insertMessage(h.app.ctx.db, { wamid: 'w1', phoneNumberId: PHONE_ID, direction: 'out', peer: '+1', type: 'text', body: {}, status: 'accepted', createdAt: 0 })
    await h.client.send(new DisassociateWhatsAppBusinessAccountCommand({ id: WABA_ID })); expect((await h.client.send(new ListLinkedWhatsAppBusinessAccountsCommand({}))).linkedAccounts).toEqual([]); expect(getMessage(h.app.ctx.db, 'w1')).toBeUndefined(); await expect(h.app.ctx.sim.applyStatus('w1', 'sent')).resolves.toBeUndefined()
  })
})
describe('tag operations', () => {
  it('tags, lists and untags a WABA ARN', async () => {
    const arn = (await h.client.send(new GetLinkedWhatsAppBusinessAccountCommand({ id: WABA_ID }))).account!.arn!
    await h.client.send(new TagResourceCommand({ resourceArn: arn, tags: [{ key: 'env', value: 'dev' }, { key: 'team', value: 'ar' }] })); await h.client.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: ['team'] }))
    expect((await h.client.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags).toEqual([{ key: 'env', value: 'dev' }])
  })
  it('rejects unknown ARNs with InvalidParametersException', async () => { const error = await h.client.send(new ListTagsForResourceCommand({ resourceArn: 'arn:aws:social-messaging:ap-south-1:000000000000:waba/nope' })).catch((caught) => caught); expect(error.name).toBe('InvalidParametersException') })
})
