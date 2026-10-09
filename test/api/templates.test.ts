import { CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateFromLibraryCommand, CreateWhatsAppMessageTemplateMediaCommand, DeleteWhatsAppMessageTemplateCommand, GetWhatsAppMessageTemplateCommand, ListWhatsAppMessageTemplatesCommand, ListWhatsAppTemplateLibraryCommand, UpdateWhatsAppMessageTemplateCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { entry, startHarness, utf8, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness({ templates: { autoApproveSeconds: 10 } }) })
afterEach(async () => { await h.close() })
const def = (over: Record<string, unknown> = {}) => utf8(JSON.stringify({ name: 'payment_received', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'We received {{1}} for invoice {{2}}.' }], ...over }))
describe('template operations', () => {
  it('creates a PENDING template that auto-approves and emits a status event', async () => {
    const out = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def() })); expect(out).toMatchObject({ templateStatus: 'PENDING', category: 'UTILITY', metaTemplateId: expect.stringMatching(/^\d+$/) })
    await h.clock.advance(10_000); const got = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: out.metaTemplateId })); expect(JSON.parse(got.template!)).toMatchObject({ name: 'payment_received', status: 'APPROVED', language: 'en_US' })
    expect(entry(h.published.at(-1)!.envelope).changes[0]).toMatchObject({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'payment_received' } })
  })
  it('rejects bad names, bad JSON and duplicates with InvalidParametersException', async () => {
    const bad = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'Bad Name' }) })).catch((error) => error); expect(bad.name).toBe('InvalidParametersException')
    const notJson = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: utf8('{') })).catch((error) => error); expect(notJson.message).toMatch(/templateDefinition is not valid JSON/)
    const duplicate = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'invoice_reminder', language: 'en' }) })).catch((error) => error); expect(duplicate.message).toMatch(/already exists/)
  })
  it('allows the same name in another language', async () => { await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'invoice_reminder', language: 'hi' }) }))).resolves.toBeDefined() })
  it('lists, gets by name+language, updates back to PENDING and deletes', async () => {
    const list = await h.client.send(new ListWhatsAppMessageTemplatesCommand({ id: WABA_ID })); expect(list.templates).toEqual([expect.objectContaining({ templateName: 'invoice_reminder', templateStatus: 'APPROVED', templateLanguage: 'en', templateCategory: 'UTILITY' })])
    const byName = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder', templateLanguageCode: 'en' })); const id = JSON.parse(byName.template!).id
    await h.client.send(new UpdateWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id, templateComponents: utf8(JSON.stringify([{ type: 'BODY', text: 'Hi {{1}}' }])) }))
    const after = JSON.parse((await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id }))).template!); expect(after).toMatchObject({ status: 'PENDING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] })
    await h.client.send(new DeleteWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder' })); const gone = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: id })).catch((error) => error); expect(gone.name).toBe('ResourceNotFoundException')
  })
  it('requires an id or name+language to get a template', async () => { const error = await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, templateName: 'invoice_reminder' })).catch((caught) => caught); expect(error.name).toBe('InvalidParametersException') })
  it('lists the library with filters and creates from it', async () => {
    const library = await h.client.send(new ListWhatsAppTemplateLibraryCommand({ id: WABA_ID, filters: { searchKey: 'payment' } })); expect(library.metaLibraryTemplates!.length).toBeGreaterThan(0); const pick = library.metaLibraryTemplates![0]
    const result = await h.client.send(new CreateWhatsAppMessageTemplateFromLibraryCommand({ id: WABA_ID, metaLibraryTemplate: { templateName: 'my_payment', libraryTemplateName: pick.templateName!, templateCategory: 'UTILITY', templateLanguage: 'en_US' } })); expect(result.templateStatus).toBe('PENDING')
    const missing = await h.client.send(new CreateWhatsAppMessageTemplateFromLibraryCommand({ id: WABA_ID, metaLibraryTemplate: { templateName: 'x', libraryTemplateName: 'nope', templateCategory: 'UTILITY', templateLanguage: 'en_US' } })).catch((error) => error); expect(missing.name).toBe('InvalidParametersException')
  })
  it('uploads template header media from S3', async () => {
    await h.blobs.put('media', 'logo.png', utf8('png-bytes'), 'image/png'); const uploaded = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'logo.png' } })); expect(uploaded.metaHeaderHandle).toMatch(/^4::/)
    const missing = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'nope.png' } })).catch((error) => error); expect(missing.name).toBe('InvalidParametersException')
  })
})
