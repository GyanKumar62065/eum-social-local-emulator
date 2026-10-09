import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import type { Envelope } from './envelope.ts'

export interface Sink { name: string; accepts(arn: string): boolean; publish(arn: string, envelope: Envelope): Promise<string> }
export function snsSink(endpoint: string, region: string): Sink {
  const clients = new Map<string, SNSClient>()
  const client = (clientRegion: string) => {
    let instance = clients.get(clientRegion)
    if (!instance) {
      instance = new SNSClient({ endpoint, region: clientRegion, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 })
      clients.set(clientRegion, instance)
    }
    return instance
  }
  return {
    name: 'sns', accepts: (arn) => arn.startsWith('arn:aws:sns:'),
    async publish(arn, envelope) {
      const clientRegion = arn.split(':')[3] || region
      const result = await client(clientRegion).send(new PublishCommand({ TopicArn: arn, Message: JSON.stringify(envelope) }))
      return `sns MessageId ${result.MessageId}`
    },
  }
}
