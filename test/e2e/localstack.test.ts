import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging'
import { CreateTopicCommand, DeleteTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns'
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config.ts'
import { phoneAwsId } from '../../src/domain/ids.ts'
import { buildApp, type App } from '../../src/server.ts'

const LS = process.env.EUM_E2E_LOCALSTACK ?? 'http://localhost:4566'
const up = await fetch(`${LS}/_localstack/health`).then((r) => r.ok).catch(() => false)
const aws = { endpoint: LS, region: 'ap-south-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }

describe.skipIf(!up)(`end to end with LocalStack at ${LS}`, () => {
  const sqs = new SQSClient(aws)
  const sns = new SNSClient(aws)
  let app: App
  let queueUrl: string
  let topicArn: string
  let client: SocialMessagingClient

  beforeAll(async () => {
    const suffix = Date.now()
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `eum-e2e-${suffix}` }))
    topicArn = TopicArn!
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `eum-e2e-${suffix}` }))).QueueUrl!
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }))
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: Attributes!.QueueArn, Attributes: { RawMessageDelivery: 'true' } }))

    const config = {
      ...parseConfig(undefined, { EUM_AWS_ENDPOINT: LS }),
      dbPath: ':memory:',
      sim: { defaultFlow: ['sent' as const, 'delivered' as const, 'read' as const], stepDelayMs: 100, rules: [] },
      wabas: [{ name: 'E2E', metaWabaId: '900000000000001', eventDestinations: [topicArn], phoneNumbers: [{ phoneNumber: '+919800000009', displayName: 'E2E', metaPhoneNumberId: '900000000000002' }] }],
    }
    app = await buildApp({ config, logger: false })
    const url = await app.fastify.listen({ port: 0, host: '127.0.0.1' })
    client = new SocialMessagingClient({ ...aws, endpoint: url, maxAttempts: 1 })
  })

  afterAll(async () => {
    client?.destroy()
    await app?.close()
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }))
    if (topicArn) await sns.send(new DeleteTopicCommand({ TopicArn: topicArn }))
    sqs.destroy()
    sns.destroy()
  })

  async function drain(count: number): Promise<any[]> {
    const got: any[] = []
    const deadline = Date.now() + 20_000
    while (got.length < count && Date.now() < deadline) {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }))
      for (const m of r.Messages ?? []) got.push(JSON.parse(m.Body!))
    }
    return got
  }

  it('delivers send failures and inbound STOP to SNS → SQS, then normal delivery statuses', async () => {
    await client.send(new SendWhatsAppMessageCommand({
      originationPhoneNumberId: phoneAwsId('900000000000002'),
      metaApiVersion: 'v20.0',
      message: new TextEncoder().encode(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'hello' } })),
    }))
    const [failed] = await drain(1)
    expect(failed.context.MetaPhoneNumberIds[0].metaPhoneNumberId).toBe('900000000000002')
    expect(JSON.parse(failed.whatsAppWebhookEntry).changes[0].value.statuses[0]).toMatchObject({ status: 'failed', errors: [{ code: 131047 }] })

    await app.ctx.sim.inbound({ phoneNumberId: phoneAwsId('900000000000002'), from: '+15550001', type: 'text', text: 'STOP' })
    const [inbound] = await drain(1)
    expect(JSON.parse(inbound.whatsAppWebhookEntry).changes[0].value.messages[0].text.body).toBe('STOP')

    await client.send(new SendWhatsAppMessageCommand({
      originationPhoneNumberId: phoneAwsId('900000000000002'),
      metaApiVersion: 'v20.0',
      message: new TextEncoder().encode(JSON.stringify({ messaging_product: 'whatsapp', to: '+15550001', type: 'text', text: { body: 'now inside the window' } })),
    }))
    const statuses = (await drain(3)).map((e) => JSON.parse(e.whatsAppWebhookEntry).changes[0].value.statuses[0].status)
    expect([...statuses].sort()).toEqual(['delivered', 'read', 'sent'])
  })
})
