import { SocialMessagingClient } from '@aws-sdk/client-socialmessaging'
import { parseConfig, type Config, type WabaSeed } from '../src/config.ts'
import { phoneAwsId, wabaAwsId } from '../src/domain/ids.ts'
import { memoryBlobStore, type MemoryBlobStore } from '../src/aws/blobStore.ts'
import type { Envelope } from '../src/events/envelope.ts'
import type { Sink } from '../src/events/sinks.ts'
import { buildApp, type App } from '../src/server.ts'
import { FakeClock } from '../src/sim/clock.ts'

export const TEST_TOPIC = 'arn:aws:sns:ap-south-1:000000000000:eum-events'
export const TEST_SEED: WabaSeed = { name: 'Example Business', metaWabaId: '100000000000001', eventDestinations: [TEST_TOPIC], phoneNumbers: [{ phoneNumber: '+919800000001', displayName: 'Example Sender', metaPhoneNumberId: '200000000000001' }], templates: [{ name: 'invoice_reminder', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, invoice {{2}} of {{3}} is due on {{4}}.' }] }] }
export const WABA_ID = wabaAwsId('100000000000001')
export const PHONE_ID = phoneAwsId('200000000000001')
export interface Harness { app: App; url: string; client: SocialMessagingClient; clock: FakeClock; published: { arn: string; envelope: Envelope }[]; blobs: MemoryBlobStore; close(): Promise<void> }
export async function startHarness(over: Partial<Config> = {}): Promise<Harness> {
  const clock = new FakeClock(); const published: { arn: string; envelope: Envelope }[] = []
  const sink: Sink = { name: 'capture', accepts: (arn) => arn.startsWith('arn:aws:sns:'), publish: async (arn, envelope) => { published.push({ arn, envelope }); return `captured-${published.length}` } }
  const blobs = memoryBlobStore()
  const config: Config = { ...parseConfig(undefined, {}), dbPath: ':memory:', wabas: [TEST_SEED], ...over }
  const app = await buildApp({ config, clock, sinks: [sink], blobStore: blobs, logger: false })
  const url = await app.fastify.listen({ port: 0, host: '127.0.0.1' })
  const client = new SocialMessagingClient({ endpoint: url, region: 'ap-south-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 })
  return { app, url, client, clock, published, blobs, close: async () => { client.destroy(); await app.close() } }
}
export const entry = (envelope: Envelope): any => JSON.parse(envelope.whatsAppWebhookEntry)
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
export const signedFetch = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { ...init, headers: { authorization: 'AWS4-HMAC-SHA256 Credential=test/20261007/ap-south-1/social-messaging/aws4_request', ...init.headers } })
