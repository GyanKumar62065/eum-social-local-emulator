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
  it('requires a same-WABA supported PDF approval sample for DOCUMENT headers on create and update', async () => {
    await h.blobs.put('media', 'sample.pdf', utf8('%PDF approval sample'), 'application/pdf')
    const { metaHeaderHandle } = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.pdf' } }))
    const documentDefinition = (handle?: string) => def({ name: 'document_notice', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { ...(handle ? { header_handle: [handle] } : {}) } }, { type: 'BODY', text: 'Your file is ready.' }] })
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: documentDefinition() }))).rejects.toMatchObject({ name: 'InvalidParametersException' })
    const duplicateHeader = utf8(JSON.stringify({ name: 'duplicate_header', language: 'en', category: 'UTILITY', components: [{ type: 'HEADER', format: 'TEXT', text: 'Hi' }, { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [metaHeaderHandle] } }] }))
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: duplicateHeader }))).rejects.toMatchObject({ name: 'InvalidParametersException' })
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: documentDefinition('missing-handle') }))).rejects.toMatchObject({ name: 'InvalidParametersException' })
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: documentDefinition(metaHeaderHandle) }))).resolves.toMatchObject({ templateStatus: 'PENDING' })
    await h.blobs.put('media', 'sample.png', utf8('png sample'), 'image/png')
    const wrongMime = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.png' } }))
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: documentDefinition(wrongMime.metaHeaderHandle) }))).rejects.toMatchObject({ name: 'InvalidParametersException' })
  })
  it('does not mutate an approved template or generation when a document sample update is invalid', async () => {
    await h.blobs.put('media', 'sample.pdf', utf8('%PDF sample'), 'application/pdf')
    const { metaHeaderHandle } = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.pdf' } }))
    const createdTemplate = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'document_update', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [metaHeaderHandle] } }] }) }))
    await h.clock.advance(10_000)
    const beforeList = await (await fetch(`${h.url}/_eum/api/templates`)).json() as any
    const before = beforeList.templates.find((template: any) => template.metaTemplateId === createdTemplate.metaTemplateId)
    const error = await h.client.send(new UpdateWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: createdTemplate.metaTemplateId, templateComponents: utf8(JSON.stringify([{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['unknown'] } }])) })).catch((caught) => caught)
    expect(error.name).toBe('InvalidParametersException')
    const after = JSON.parse((await h.client.send(new GetWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: createdTemplate.metaTemplateId }))).template!)
    expect(after).toMatchObject({ status: before.status, components: before.components })
  })
  it('rejects an approval sample owned by another WABA', async () => {
    const created = await fetch(`${h.url}/_eum/api/wabas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other WABA', phoneNumbers: [{ phoneNumber: '+919800000002', displayName: 'Other' }] }) })
    const otherWabaId = (await created.json() as any).waba.id
    await h.blobs.put('media', 'other-waba.pdf', utf8('%PDF other WABA'), 'application/pdf')
    const sample = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: otherWabaId, sourceS3File: { bucketName: 'media', key: 'other-waba.pdf' } }))
    const templateDefinition = utf8(JSON.stringify({ name: 'foreign_sample', language: 'en', category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }] }))
    await expect(h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition }))).rejects.toMatchObject({ name: 'InvalidParametersException' })
  })
  it('cannot approve a newer document template generation with a stale decision', async () => {
    await h.blobs.put('media', 'sample.pdf', utf8('%PDF approval'), 'application/pdf')
    const sample = await h.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'media', key: 'sample.pdf' } }))
    const createdTemplate = await h.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: def({ name: 'generation_document', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }] }) }))
    await h.clock.advance(10_000)
    const beforeList = await (await fetch(`${h.url}/_eum/api/templates`)).json() as any
    const before = beforeList.templates.find((template: any) => template.metaTemplateId === createdTemplate.metaTemplateId)
    await h.client.send(new UpdateWhatsAppMessageTemplateCommand({ id: WABA_ID, metaTemplateId: createdTemplate.metaTemplateId, templateComponents: utf8(JSON.stringify([{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }, { type: 'BODY', text: 'Updated {{1}}' }])) }))
    const stale = await fetch(`${h.url}/_eum/api/templates/${createdTemplate.metaTemplateId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation: before.generation, expectedStatus: before.status }) })
    expect(stale.status).toBe(409)
    const currentList = await (await fetch(`${h.url}/_eum/api/templates`)).json() as any
    const current = currentList.templates.find((template: any) => template.metaTemplateId === createdTemplate.metaTemplateId)
    expect(current).toMatchObject({ generation: before.generation + 1, status: 'PENDING' })
  })
})
