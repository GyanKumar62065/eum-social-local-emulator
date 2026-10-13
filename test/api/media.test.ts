import { CreateWhatsAppMessageTemplateCommand, CreateWhatsAppMessageTemplateMediaCommand, DeleteWhatsAppMessageMediaCommand, GetWhatsAppMessageMediaCommand, PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PHONE_ID, startHarness, utf8, WABA_ID, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })
describe('media operations', () => {
  it('uploads from S3, reads metadata, copies back to S3 and deletes', async () => {
    await h.blobs.put('input', 'invoice.pdf', utf8('%PDF-1.7'), 'application/pdf')
    const { mediaId } = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'input', key: 'invoice.pdf' } })); expect(mediaId).toMatch(/^\d+$/)
    expect(await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, metadataOnly: true }))).toMatchObject({ mimeType: 'application/pdf', fileSize: 8 })
    await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, destinationS3File: { bucketName: 'output', key: 'copy.pdf' } })); expect(Buffer.from(h.blobs.objects.get('output/copy.pdf')!.bytes).toString()).toBe('%PDF-1.7')
    expect(await h.client.send(new DeleteWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId! }))).toMatchObject({ success: true })
    const gone = await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId!, metadataOnly: true })).catch((error) => error); expect(gone.name).toBe('ResourceNotFoundException')
  })
  it('serves media received from a customer', async () => {
    const message = await h.app.ctx.sim.inbound({ phoneNumberId: PHONE_ID, from: '+15550001', type: 'image', mediaBase64: Buffer.from('img').toString('base64'), mimeType: 'image/png' })
    expect(await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: message.body.image.id, metadataOnly: true }))).toMatchObject({ mimeType: 'image/png', fileSize: 3 })
  })
  it('keeps uploaded media bytes available after reopening the SQLite database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eum-media-restart-'))
    const dbPath = join(directory, 'emulator.db')
    const first = await startHarness({ dbPath, templates: { autoApproveSeconds: 0 } })
    try {
      const original = utf8('%PDF bytes that must survive restart')
      await first.blobs.put('input', 'approval.pdf', utf8('%PDF approval sample'), 'application/pdf')
      const sample = await first.client.send(new CreateWhatsAppMessageTemplateMediaCommand({ id: WABA_ID, sourceS3File: { bucketName: 'input', key: 'approval.pdf' } }))
      await first.client.send(new CreateWhatsAppMessageTemplateCommand({ id: WABA_ID, templateDefinition: utf8(JSON.stringify({ name: 'persisted_document', language: 'en', category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [sample.metaHeaderHandle] } }] })) }))
      await first.clock.advance(0)
      await first.blobs.put('input', 'persisted.pdf', original, 'application/pdf')
      const uploaded = await first.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'input', key: 'persisted.pdf' } }))
      const sent = await first.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: PHONE_ID, metaApiVersion: 'v20.0', message: utf8(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'template', template: { name: 'persisted_document', language: { code: 'en' }, components: [{ type: 'header', parameters: [{ type: 'document', document: { id: uploaded.mediaId, filename: 'persisted.pdf' } }] }] } })) }))
      await first.close()
      h = await startHarness({ dbPath, templates: { autoApproveSeconds: 0 } })
      const metadata = await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: uploaded.mediaId, metadataOnly: true }))
      expect(metadata).toMatchObject({ mimeType: 'application/pdf', fileSize: original.byteLength })
      const downloaded = await fetch(`${h.url}/_eum/api/media/${uploaded.mediaId}`)
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(original)
      const messages = await (await fetch(`${h.url}/_eum/api/messages`)).json() as any
      const persistedMessage = messages.messages.find((message: any) => message.awsMessageId === sent.messageId)
      expect(persistedMessage.trace.mediaValidation).toMatchObject({ mediaId: uploaded.mediaId, filename: 'persisted.pdf', size: original.byteLength })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('requires exactly one source and a destination unless metadataOnly', async () => {
    const none = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID })).catch((error) => error); expect(none.name).toBe('InvalidParametersException')
    const missing = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'input', key: 'nope' } })).catch((error) => error); expect(missing.message).toMatch(/Could not read s3:\/\/input\/nope/)
    await h.blobs.put('input', 'a.png', utf8('x'), 'image/png'); const { mediaId } = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3File: { bucketName: 'input', key: 'a.png' } }))
    const noDestination = await h.client.send(new GetWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, mediaId: mediaId! })).catch((error) => error); expect(noDestination.name).toBe('InvalidParametersException')
  })
  it('does not fetch a URL whose host is outside Amazon S3', async () => {
    const error = await h.client.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: PHONE_ID, sourceS3PresignedUrl: { url: 'https://example.com/s3.amazonaws.com/object', headers: {} } })).catch((caught) => caught)
    expect(error.name).toBe('InvalidParametersException')
    expect(error.message).toMatch(/Amazon S3 URL/)
  })
})
