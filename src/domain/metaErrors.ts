export interface MetaError { code: number; title: string }
export const META_ERRORS_HREF = 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/'
export const META_ERROR_TITLES: Record<number, string> = {
  131000: 'Something went wrong', 131026: 'Message undeliverable', 131047: 'Re-engagement message',
  131049: 'This message was not delivered to maintain healthy ecosystem engagement.',
  131050: 'Unable to deliver the message. This recipient has chosen to stop receiving marketing messages on WhatsApp from your business.',
  132000: 'Number of parameters does not match the expected number of params', 132001: 'Template name does not exist in the translation',
}
export const metaError = (code: number, title?: string): MetaError => ({ code, title: title ?? META_ERROR_TITLES[code] ?? 'Unknown error' })
