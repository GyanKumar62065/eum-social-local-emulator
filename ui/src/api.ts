export interface Phone { id: string; wabaId: string; phoneNumber: string; displayName: string; metaPhoneNumberId: string }
export interface Waba { id: string; name: string; metaWabaId: string; registrationStatus: string; eventDestinations: { eventDestinationArn: string }[]; phoneNumbers: Phone[] }
export interface Message { wamid: string; awsMessageId?: string; phoneNumberId: string; direction: 'out' | 'in'; peer: string; type: string; body: any; renderedText?: string; status: string; errorCode?: number; errorTitle?: string; createdAt: number }
export interface Template { metaTemplateId: string; wabaId: string; name: string; language: string; category: string; status: string; generation: number; rejectionReason?: string; components: { type: string; text?: string; [key: string]: unknown }[] }
export interface Delivery { destination: string; ok: boolean; detail: string }
export interface EventRow { id: string; kind: string; wamid?: string; envelope: { whatsAppWebhookEntry: string; [key: string]: unknown }; deliveries: Delivery[]; deliveryAttempts?: { destination: string; attempts: { at: number; ok: boolean; detail: string }[] }[]; at: number }
export interface MessageDetail { message: Message; history: { status: string; errorCode?: number; at: number }[]; events: EventRow[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/_eum/api${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? response.statusText)
  return json as T
}
export const api = {
  wabas: () => call<{ wabas: Waba[] }>('GET', '/wabas'),
  messages: () => call<{ messages: Message[] }>('GET', '/messages?limit=1000'),
  message: (wamid: string) => call<MessageDetail>('GET', `/messages/${encodeURIComponent(wamid)}`),
  setStatus: (wamid: string, status: string, code?: number) => call('POST', `/messages/${encodeURIComponent(wamid)}/status`, { status, code }),
  inbound: (body: { phoneNumberId: string; from: string; type: 'text' | 'button' | 'image' | 'interactive'; text?: string; payload?: string; interactiveType?: 'button_reply' | 'list_reply'; id?: string; title?: string; description?: string; contextMessageId?: string; mediaBase64?: string; mimeType?: string }) => call<{ message: Message }>('POST', '/inbound', body),
  templates: () => call<{ templates: Template[] }>('GET', '/templates'),
  approve: (id: string, generation: number, expectedStatus: string) => call('POST', `/templates/${id}/approve`, { generation, expectedStatus }),
  reject: (id: string, reason: string, generation: number, expectedStatus: string) => call('POST', `/templates/${id}/reject`, { reason, generation, expectedStatus }),
  setTemplateState: (id: string, state: 'pause' | 'disable', generation: number, expectedStatus: string) => call('POST', `/templates/${id}/${state}`, { generation, expectedStatus }),
  events: () => call<{ events: EventRow[] }>('GET', '/events?limit=300'),
  replayEvent: (id: string, destination: string) => call<{ event: EventRow }>('POST', `/events/${encodeURIComponent(id)}/replay`, { destination }),
  reset: () => call('POST', '/reset', {}),
}
export function onChange(fn: () => void): () => void {
  const stream = new EventSource('/_eum/api/stream')
  for (const type of ['message', 'status', 'event', 'template', 'waba', 'reset']) stream.addEventListener(type, fn)
  return () => stream.close()
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
