import { GetWhatsAppFlowCommand, SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signedFetch, startHarness, type Harness } from '../helpers.ts'
let h: Harness
beforeEach(async () => { h = await startHarness() })
afterEach(async () => { await h.close() })
describe('AWS API pipeline', () => {
  it('returns 501 InternalServiceException for operations without a handler', async () => {
    const error = await h.client.send(new GetWhatsAppFlowCommand({ id: 'waba-1', flowId: '123' })).catch((caught) => caught)
    expect(error.name).toBe('InternalServiceException'); expect(error.message).toMatch(/GetWhatsAppFlow is not simulated yet/); expect(error.$metadata.httpStatusCode).toBe(501)
  })
  it('validates input through the real SDK', async () => {
    const error = await h.client.send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: 'bad-id', message: new Uint8Array([1]), metaApiVersion: 'v20.0' })).catch((caught) => caught)
    expect(error.name).toBe('ValidationException'); expect(error.message).toMatch(/originationPhoneNumberId.*regular expression/); expect(error.$metadata.httpStatusCode).toBe(400)
  })
  it('rejects unsigned requests', async () => { const response = await fetch(`${h.url}/v1/whatsapp/waba/list`); expect(response.status).toBe(403); expect(response.headers.get('x-amzn-errortype')).toBe('AccessDeniedException') })
  it('returns ValidationException for a non-JSON body (Review Focus 4)', async () => {
    const response = await signedFetch(`${h.url}/v1/whatsapp/send`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(400); expect(response.headers.get('x-amzn-errortype')).toBe('ValidationException'); expect(await response.json()).toEqual({ message: 'Request body is not valid JSON' })
  })
  it('returns ValidationException for a mistyped query value (Review Focus 4)', async () => {
    const response = await signedFetch(`${h.url}/v1/whatsapp/waba/list?maxResults=abc`); expect(response.status).toBe(400); expect((await response.json()).message).toMatch(/maxResults.*integer/)
  })
  it('returns 404 for unknown routes and a request id on every response', async () => {
    const response = await signedFetch(`${h.url}/v1/whatsapp/nope`); expect(response.status).toBe(404); expect(response.headers.get('x-amzn-requestid')).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('serves health', async () => { expect(await (await fetch(`${h.url}/_eum/health`)).json()).toEqual({ status: 'ok' }) })
  it('simulates exactly the 22 v1 operations', async () => {
    const { coverage } = await import('../../src/api/aws.ts')
    const result = coverage(h.app.model, h.app.handlers)
    expect(result.simulated).toHaveLength(22)
    expect(result.notSimulated).toHaveLength(16)
    expect(result.notSimulated.every((name) => /Flow|Call|Dataset|ConversionEvent|BusinessPublicKey/.test(name))).toBe(true)
  })
})
