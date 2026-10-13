import { CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateMediaCommand, DeleteWhatsAppMessageMediaCommand, DisassociateWhatsAppBusinessAccountCommand, GetLinkedWhatsAppBusinessAccountPhoneNumberCommand, PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { getMessage, listMessages } from '../../src/store/messages.ts'
import { entry, PHONE_ID, startHarness, TEST_TOPIC, utf8, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
afterEach(async () => { await h.close() })
const template = (to: string, params: string[]) => utf8(JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } }))
const PARAMS = ['Asha', 'INV-1042', '₹12,000', '9 Oct']
const send = (message: Uint8Array, originationPhoneNumberId = PHONE_ID) => h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId, message, metaApiVersion: 'v20.0' }))
const statuses = () => h.published.map((item) => entry(item.envelope).changes[0].value.statuses?.[0]).filter(Boolean)
describe('SendWhatsAppMessage', () => {
  it('sends an approved document header using phone-owned runtime media and records its validation details', async () => {
    h = await startHarness({ templates: { autoApproveSeconds: 1 } })
    const approvalBytes = utf8('%PDF approval sample')
    const actualBytes = utf8('%PDF actual invoice bytes\nnot the approval sample')
    await h.blobs.put('media', 'approval.pdf', approvalBytes, 'application/pdf')
    const sample = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'approval.pdf' } }))
    const definition = utf8(JSON.stringify({ name: 'document_receipt', language: 'en', category: 'UTILITY', components: [
      { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } },
      { type: 'BODY', text: 'Hi {{1}}, your invoice {{2}} is ready.' },
      { type: 'FOOTER', text: 'Thank you' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open invoice', url: 'https://local.invalid/invoices/{{1}}' }, { type: 'URL', text: 'All files', url: 'https://local.invalid/files' }] },
    ] }))
    const created = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: definition }))
    await h.clock.advance(24 * 60 * 60 * 1000)
    await h.blobs.put('media', 'actual.pdf', actualBytes, 'application/pdf')
    const uploaded = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'media', key: 'actual.pdf' } }))
    const payload = utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'document_receipt', language: { code: 'en' }, components: [
      { type: 'header', parameters: [{ type: 'document', document: { id: uploaded.mediaId, filename: 'invoice-october.pdf' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'INV-1042' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'INV-1042' }] },
    ] } }))
    const sent = await send(payload)
    const message = listMessages(h.app.ctx.db, {}).find((item) => item.awsMessageId === sent.messageId)
    expect(message?.trace).toMatchObject({ template: { name: 'document_receipt', language: 'en', generation: 1 }, mediaValidation: { result: 'valid', mediaId: uploaded.mediaId, filename: 'invoice-october.pdf', mimeType: 'application/pdf', size: actualBytes.byteLength } })
    expect(message?.trace?.mediaValidation?.sha256).toBe(createHash('sha256').update(actualBytes).digest('base64'))
    const metadataResponse = await fetch(`${h.url}/_eum/api/media/${uploaded.mediaId}/metadata`)
    expect(await metadataResponse.json()).toMatchObject({ mediaId: uploaded.mediaId, mimeType: 'application/pdf', size: actualBytes.byteLength, sha256: createHash('sha256').update(actualBytes).digest('base64'), available: true })
    const download = await fetch(`${h.url}/_eum/api/media/${uploaded.mediaId}/download?filename=${encodeURIComponent('invoice-october.pdf')}`)
    expect(download.headers.get('content-disposition')).toContain('filename="invoice-october.pdf"')
    const downloadedBytes = new Uint8Array(await download.arrayBuffer())
    expect(downloadedBytes).toEqual(actualBytes)
    expect(createHash('sha256').update(downloadedBytes).digest('base64')).toBe(createHash('sha256').update(actualBytes).digest('base64'))
    expect(message?.renderedText).toContain('Hi Asha, your invoice INV-1042 is ready.')
    expect(message?.renderedText).toContain('Thank you')
    expect(message?.renderedText).toContain('Open invoice: https://local.invalid/invoices/INV-1042')
    expect(message?.renderedText).toContain('All files: https://local.invalid/files')
    await h.clock.advance(3000)
    expect(statuses().map((status) => status.status)).toEqual(['sent', 'delivered', 'read'])
    const reply = await h.app.ctx.sim.inbound({ phoneNumberId: PHONE_ID, from: '+15550001', type: 'text', text: 'Got the invoice', contextMessageId: message!.wamid })
    expect(reply.body.context.id).toBe(message!.wamid)
    expect(entry(h.published.at(-1)!.envelope).changes[0].value.messages[0]).toMatchObject({ id: reply.wamid, context: { id: message!.wamid } })
  })
  it('rejects invalid document headers and foreign runtime media before enqueueing delivery', async () => {
    h = await startHarness({ templates: { autoApproveSeconds: 1 } })
    await h.blobs.put('media', 'sample.pdf', utf8('%PDF sample'), 'application/pdf')
    const sample = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.pdf' } }))
    await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: utf8(JSON.stringify({ name: 'document_restricted', language: 'en', category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }] })) }))
    await h.clock.advance(1000)
    const missing = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'missing', key: 'x.pdf' } })).catch((caught) => caught)
    expect(missing.name).toBe('InvalidParametersException')
    await h.blobs.put('media', 'image.png', utf8('image bytes'), 'image/png')
    const image = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'media', key: 'image.png' } }))
    await h.blobs.put('media', 'deleted.pdf', utf8('%PDF deleted'), 'application/pdf')
    const deleted = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'media', key: 'deleted.pdf' } }))
    await h.client.send(new DeleteWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: deleted.mediaId }))
    const make = (headerComponents: unknown[]) => utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'document_restricted', language: { code: 'en' }, components: headerComponents } }))
    const invalidPayloads = [
      make([]),
      make([{ type: 'header', parameters: [{ type: 'text', text: 'not a document' }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { filename: 'missing-id.pdf' } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: image.mediaId } }, { type: 'document', document: { id: image.mediaId } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: image.mediaId } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: sample.metaHeaderHandle } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: 'missing-runtime-media' } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: deleted.mediaId } }] }]),
      make([{ type: 'header', parameters: [{ type: 'document', document: { id: image.mediaId } }] }, { type: 'header', parameters: [{ type: 'document', document: { id: image.mediaId } }] }]),
    ]
    for (const payload of invalidPayloads) await expect(send(payload)).rejects.toMatchObject({ name: expect.stringMatching(/InvalidParametersException|ResourceNotFoundException/) })
    expect(listMessages(h.app.ctx.db, {}).filter((message) => message.body?.template?.name === 'document_restricted')).toHaveLength(0)
    await h.clock.advance(5000)
    expect(statuses()).toEqual([])
  })
  it('rejects runtime media uploaded through a different sending phone number', async () => {
    h = await startHarness({ templates: { autoApproveSeconds: 1 } })
    await h.blobs.put('media', 'sample.pdf', utf8('%PDF sample'), 'application/pdf')
    const sample = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.pdf' } }))
    await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: utf8(JSON.stringify({ name: 'document_phone_scope', language: 'en', category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }] })) }))
    await h.clock.advance(1000)
    const createdWabaResponse = await fetch(`${h.url}/_eum/api/wabas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other business', phoneNumbers: [{ phoneNumber: '+919800000002', displayName: 'Other sender' }] }) })
    expect(createdWabaResponse.status).toBe(201)
    const wabas = await (await fetch(`${h.url}/_eum/api/wabas`)).json() as any
    const otherPhoneId = wabas.wabas.flatMap((waba: any) => waba.phoneNumbers).find((phone: any) => phone.phoneNumber === '+919800000002').id
    await h.blobs.put('media', 'foreign.pdf', utf8('%PDF foreign'), 'application/pdf')
    const foreign = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: otherPhoneId, sourceS3File: { bucketName: 'media', key: 'foreign.pdf' } }))
    const payload = utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'document_phone_scope', language: { code: 'en' }, components: [{ type: 'header', parameters: [{ type: 'document', document: { id: foreign.mediaId } }] }] } }))
    await expect(send(payload)).rejects.toMatchObject({ name: 'ResourceNotFoundException' })
    expect(listMessages(h.app.ctx.db, {})).toHaveLength(0)
  })
  it('returns a messageId, renders the template and emits sent → delivered → read on SNS', async () => {
    h = await startHarness(); const result = await send(template('+15550001', PARAMS)); expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/)
    const [message] = listMessages(h.app.ctx.db, {}); expect(message).toMatchObject({ awsMessageId: result.messageId, peer: '+15550001', renderedText: 'Hi Asha, invoice INV-1042 of ₹12,000 is due on 9 Oct.', category: 'utility', status: 'accepted' })
    await h.clock.advance(3000); expect(statuses().map((status) => status.status)).toEqual(['sent', 'delivered', 'read']); expect(statuses()[0]).toMatchObject({ id: message.wamid, recipient_id: '15550001', pricing: { category: 'utility', billable: true } })
    expect(h.published[0].arn).toBe(TEST_TOPIC); expect(h.published[0].envelope.context.MetaPhoneNumberIds).toEqual([{ metaPhoneNumberId: '200000000000001', arn: expect.stringContaining(':phone-number-id/') }]); expect(getMessage(h.app.ctx.db, message.wamid)?.status).toBe('read')
  })
  it('accepts the phone number ARN as originationPhoneNumberId (Review Focus 1)', async () => { h = await startHarness(); const arn = (await h.client.send(new GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({ id: PHONE_ID }))).phoneNumber!.arn!; await expect(send(template('+15550001', PARAMS), arn)).resolves.toMatchObject({ messageId: expect.any(String) }) })
  it('returns the wamid when messageIdMode is wamid', async () => { h = await startHarness({ messageIdMode: 'wamid' }); expect((await send(template('+15550001', PARAMS))).messageId).toMatch(/^wamid\./) })
  it('fails asynchronously with 132000 on a parameter mismatch', async () => { h = await startHarness(); await send(template('+15550001', ['only-one'])); await h.clock.advance(1000); expect(statuses()).toEqual([expect.objectContaining({ status: 'failed', errors: [expect.objectContaining({ code: 132000 })] })]) })
  it('fails free-form text with 131047 outside the 24h window', async () => { h = await startHarness(); await send(utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'hello' } }))); await h.clock.advance(1000); expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131047 }] }) })
  it('applies a failure rule from config', async () => { h = await startHarness({ sim: { defaultFlow: ['sent', 'delivered', 'read'], stepDelayMs: 1000, rules: [{ match: { to: '*0000' }, outcome: { status: 'failed', code: 131026 } }] } }); await send(template('+15550000', PARAMS)); await h.clock.advance(1000); expect(statuses()[0]).toMatchObject({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }) })
  it('rejects malformed Meta payloads synchronously', async () => {
    h = await startHarness()
    for (const [message, pattern] of [[utf8('not json'), /not valid JSON/], [utf8(JSON.stringify({ to: '+1', type: 'text' })), /messaging_product/], [utf8(JSON.stringify({ messaging_product: 'whatsapp', type: 'text' })), /"to"/], [utf8(JSON.stringify({ messaging_product: 'whatsapp', to: 'abc', type: 'text' })), /"to"/]] as const) {
      const error = await send(message).catch((caught) => caught); expect(error.name).toBe('InvalidParametersException'); expect(error.message).toMatch(pattern)
    }
    const badVersion = await h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: PHONE_ID, message: template('+1', PARAMS), metaApiVersion: 'latest' })).catch((error) => error); expect(badVersion.message).toMatch(/metaApiVersion/)
  })
  it('returns ResourceNotFoundException for unknown and disassociated numbers (Review Focus 2)', async () => {
    h = await startHarness(); expect((await send(template('+1', PARAMS), 'phone-number-id-nope').catch((error) => error)).name).toBe('ResourceNotFoundException'); await send(template('+15550001', PARAMS)); await h.client.send(new DisassociateWhatsAppBusinessAccountCommand({ id: WABA_ID })); await h.clock.advance(5000); expect(h.published).toEqual([]); expect((await send(template('+1', PARAMS)).catch((error) => error)).name).toBe('ResourceNotFoundException')
  })
})
