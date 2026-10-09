import type { StatusName } from '../config.ts'

export type RegistrationStatus = 'COMPLETE' | 'INCOMPLETE'
export interface EventDestination { eventDestinationArn: string; roleArn?: string }
export interface WabaRow { id: string; arn: string; metaWabaId: string; name: string; registrationStatus: RegistrationStatus; linkDate: number; eventDestinations: EventDestination[]; associateToken?: string }
export interface PhoneRow { id: string; arn: string; wabaId: string; metaPhoneNumberId: string; phoneNumber: string; displayPhoneNumber: string; displayName: string; qualityRating: string; dataLocalizationRegion?: string; callSettings?: unknown }
export interface TemplateComponent { type: string; text?: string; format?: string; [key: string]: unknown }
export interface TemplateRow { metaTemplateId: string; wabaId: string; name: string; language: string; category: string; status: string; parameterFormat: string; components: TemplateComponent[]; definition?: Record<string, unknown>; generation?: number; rejectionReason?: string; createdAt: number; updatedAt: number }
export type MessageStatus = 'accepted' | 'received' | StatusName
export interface MessageRow { wamid: string; awsMessageId?: string; phoneNumberId: string; direction: 'out' | 'in'; peer: string; type: string; body: any; renderedText?: string; category?: string; status: MessageStatus; errorCode?: number; errorTitle?: string; createdAt: number }
export interface StatusHistoryRow { status: string; errorCode?: number; at: number }
export interface MediaRow { mediaId: string; ownerId: string; mimeType: string; sha256: string; bytes: Uint8Array; createdAt: number }
export interface Tag { key: string; value?: string }
export type EventKind = 'status' | 'inbound' | 'template_status'
export interface DeliveryAttempt { at: number; ok: boolean; detail: string }
export interface Delivery { destination: string; ok: boolean; detail: string; attempts?: DeliveryAttempt[] }
export interface DestinationAttempts { destination: string; attempts: DeliveryAttempt[] }
export interface EventEnvelope {
  context: {
    MetaWabaIds: { wabaId: string; arn: string }[]
    MetaPhoneNumberIds: { metaPhoneNumberId: string; arn: string }[]
  }
  whatsAppWebhookEntry: string
  aws_account_id: string
  message_timestamp: string
  messageId: string
}
export interface EventRow { id: string; kind: EventKind; wabaId?: string; wamid?: string; envelope: EventEnvelope; deliveries: Delivery[]; deliveryAttempts?: DestinationAttempts[]; at: number }
