import { Fragment, useEffect, useMemo, useState } from 'react'
import { Check, Clipboard, Link2 } from 'lucide-react'
import { Badge } from './components/ui/badge.tsx'
import { Button } from './components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { api, errorText, type EventRow, type Message, type MessageDetail, type Template, type Waba } from './api.ts'
import { resolveButtonDestination } from './TemplatePreview.tsx'

const CODES = [131026, 131047, 131049, 131050, 132000, 132001]
type TemplateButton = Record<string, unknown>
type TraceEntry = { at: number; type: 'status' | 'event'; title: string; detail?: string; status?: string; event?: EventRow }

function pretty(value: unknown): string { return JSON.stringify(value, null, 2) }
function webhook(event: EventRow): Record<string, any> {
  try { return JSON.parse(event.envelope.whatsAppWebhookEntry) }
  catch { return {} }
}
function eventTitle(event: EventRow): string {
  const value = webhook(event).changes?.[0]?.value ?? {}
  if (value.statuses?.[0]) {
    const status = value.statuses[0]
    return `Status event · ${status.status}${status.errors?.[0]?.code ? ` · ${status.errors[0].code}` : ''}`
  }
  if (value.messages?.[0]) return `Inbound event · ${value.messages[0].type}`
  if (value.event) return `Template event · ${value.event}`
  return `${event.kind.replaceAll('_', ' ')} event`
}
function eventIdentifiers(event: EventRow): string[] {
  const value = webhook(event).changes?.[0]?.value ?? {}
  return [value.statuses?.[0]?.id, value.messages?.[0]?.id].filter((id): id is string => typeof id === 'string')
}
function buttonList(template: Template | undefined): TemplateButton[] {
  return template?.components.flatMap((component) => Array.isArray(component.buttons) ? component.buttons as TemplateButton[] : []) ?? []
}
function buttonExplanation(kind: string): string {
  if (kind === 'URL') return 'The destination is shown as local preview text. It never opens a browser or sends a request.'
  if (kind === 'QUICK_REPLY') return 'Clicking this button in the inbox preview creates a simulated inbound customer reply with this title and payload ID.'
  if (kind === 'FLOW') return 'The local preview shows the Flow reference only. Flow screens, submissions, and resulting events are not simulated.'
  if (kind === 'PHONE_NUMBER') return 'The configured number is displayed for inspection. The preview does not place a call or create an inbound event.'
  if (kind === 'COPY_CODE' || kind === 'OTP') return 'The preview shows a local confirmation only. It does not access the system clipboard or create an inbound event.'
  return 'This button is displayed for inspection only and does not trigger a simulated action.'
}
function readableTime(at: number): string { return new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }

export function Inspector({ wamid, tick, templates, wabas, onClose, onSelectMessage, onError }: {
  wamid: string | null
  tick: number
  templates: Template[]
  wabas: Waba[]
  onClose: () => void
  onSelectMessage: (wamid: string) => void
  onError: (error: string) => void
}) {
  const [data, setData] = useState<MessageDetail | null>(null)
  const [code, setCode] = useState(131026)
  const [copied, setCopied] = useState('')
  const [mediaAvailable, setMediaAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    if (!wamid) { setData(null); return }
    let active = true
    setMediaAvailable(null)
    api.message(wamid).then((detail) => {
      if (!active) return
      setData(detail)
      const mediaId = detail.message.trace?.mediaValidation?.mediaId
      if (mediaId) api.mediaMetadata(mediaId).then((metadata) => { if (active) setMediaAvailable(metadata.available) }).catch(() => { if (active) setMediaAvailable(false) })
      else setMediaAvailable(null)
    }).catch((error) => { if (active) onError(errorText(error)) })
    return () => { active = false }
  }, [wamid, tick, onError])

  const timeline = useMemo<TraceEntry[]>(() => {
    if (!data) return []
    return [
      ...data.history.map((item) => ({ at: item.at, type: 'status' as const, title: `Status · ${item.status}`, status: item.status, detail: item.errorCode ? `Error ${item.errorCode}` : undefined })),
      ...data.events.map((event) => ({ at: event.at, type: 'event' as const, title: eventTitle(event), event })),
    ].sort((a, b) => a.at - b.at || (a.type === 'status' ? -1 : 1))
  }, [data])

  if (!data) return <aside className="inspector empty-inspector"><div className="inspect-icon">⌕</div><strong>Message details</strong><span>Select a message to inspect its payload, status history and delivery events.</span></aside>

  const message = data.message
  const phone = wabas.flatMap((waba) => waba.phoneNumbers).find((item) => item.id === message.phoneNumberId)
  const templateName = message.body?.template?.name
  const template = message.type === 'template' ? templates.find((item) => item.wabaId === phone?.wabaId && item.name === templateName && item.language === message.body?.template?.language?.code) : undefined
  const templateButtons = buttonList(template)
  const messageKind = message.type === 'interactive' ? String(message.body?.interactive?.type ?? message.body?.interactiveType ?? 'interactive reply').replaceAll('_', ' ') : message.type.replaceAll('_', ' ')
  const customerButton = message.body?.button
  const interactive = message.body?.interactive
  const selectedReply = interactive?.button_reply ?? interactive?.list_reply
  const contextId = message.body?.context?.id

  async function copy(key: string, value: unknown) {
    try { await navigator.clipboard.writeText(typeof value === 'string' ? value : pretty(value)); setCopied(key); window.setTimeout(() => setCopied((current) => current === key ? '' : current), 1300) }
    catch { onError('Clipboard access is unavailable. Select and copy the payload manually.') }
  }
  const copyButton = (key: string, value: unknown) => <Button variant="ghost" size="sm" className="copy-button" onClick={() => void copy(key, value)}>{copied === key ? <Check /> : <Clipboard />}{copied === key ? 'Copied' : 'Copy'}</Button>
  const push = (status: string, failureCode?: number) => api.setStatus(message.wamid, status, failureCode).catch((error) => onError(errorText(error)))
  async function replay(eventId: string, destination: string) {
    try { const result = await api.replayEvent(eventId, destination); setData((current) => current ? { ...current, events: current.events.map((event) => event.id === eventId ? result.event : event) } : current) }
    catch (error) { onError(errorText(error)) }
  }

  return <aside className="inspector">
    <div className="inspector-title"><span className="inspect-icon">⌕</span><div><strong>Message trace</strong><span>Local emulator inspection</span></div><Button variant="ghost" size="icon" className="inspector-close" aria-label="Close message details" onClick={onClose}>×</Button></div>
    <div className="detail-card">
      <div className="detail-label">MESSAGE</div>
      <strong className="message-summary-title">{message.direction === 'out' ? 'Business to customer' : 'Customer to business'}</strong>
      <div className="message-summary-grid"><span>Type</span><strong>{messageKind}{templateName ? ` · ${templateName}` : ''}</strong><span>From</span><strong>{message.direction === 'out' ? phone?.phoneNumber ?? 'Business number' : message.peer}</strong><span>To</span><strong>{message.direction === 'out' ? message.peer : phone?.phoneNumber ?? 'Business number'}</strong><span>Created</span><strong>{readableTime(message.createdAt)}</strong></div>
      <div className="detail-label spaced">CURRENT STATUS</div>
      <Badge variant={message.status === 'failed' ? 'destructive' : 'secondary'} className={`status-pill ${message.status}`}>{message.status === 'read' ? '✓✓' : message.status === 'failed' ? '!' : '●'} &nbsp;{message.status}{message.errorCode ? ` · ${message.errorCode}` : ''}</Badge>
      <details className="message-id-detail"><summary>Provider and correlation IDs</summary><span>WhatsApp message ID</span><code>{message.wamid}</code>{message.awsMessageId && <><span>AWS message ID</span><code>{message.awsMessageId}</code></>}{contextId && <><span>Reply context</span><code>{contextId}</code></>}</details>
    </div>

    {message.trace ? <section className="inspector-section"><h4>AWS OPERATION</h4><div className="operation-summary"><strong>{message.trace.operation}</strong><Badge variant="outline">Simulated locally</Badge></div><p className="inspector-hint">Request and response are the emulator’s normalized operation data. AWS credentials and authorization headers are not captured.</p>
      <details className="raw-block"><summary>Request input</summary><div className="raw-tools">{copyButton('request', message.trace.request)}</div><pre>{pretty(message.trace.request)}</pre></details>
      <details className="raw-block"><summary>API response</summary><div className="raw-tools">{copyButton('response', message.trace.response)}</div><pre>{pretty(message.trace.response)}</pre></details>
    </section> : message.direction === 'out' && <section className="inspector-section"><h4>AWS OPERATION</h4><p className="inspector-hint">This message predates operation trace capture. New AWS sends show their normalized request and response here.</p></section>}

    {message.renderedText && <section className="inspector-section"><h4>MESSAGE CONTENT</h4><p className="inspector-message-content">{message.renderedText}</p></section>}

    {message.type === 'template' && <section className="inspector-section"><h4>TEMPLATE AND MEDIA VALIDATION</h4><div className="message-summary-grid action-summary"><span>Template</span><strong>{message.trace?.template?.name ?? template?.name ?? templateName ?? 'Unavailable'}</strong><span>Language</span><strong>{message.trace?.template?.language ?? template?.language ?? message.body?.template?.language?.code ?? '—'}</strong><span>Generation</span><strong>{message.trace?.template?.generation ?? template?.generation ?? 'Unavailable'}</strong><span>Header format</span><strong>{String(message.trace?.template?.headerFormat ?? template?.components.find((component) => String(component.type).toUpperCase() === 'HEADER')?.format ?? 'None')}</strong></div>
      {message.trace?.mediaValidation ? <><div className="message-summary-grid action-summary"><span>Validation</span><strong>Valid at send time</strong><span>Media ID</span><code>{message.trace.mediaValidation.mediaId}</code><span>Filename</span><strong>{message.trace.mediaValidation.filename}</strong><span>MIME type</span><strong>{message.trace.mediaValidation.mimeType}</strong><span>Size</span><strong>{message.trace.mediaValidation.size.toLocaleString()} bytes</strong><span>SHA-256</span><code className="hash-value">{message.trace.mediaValidation.sha256}</code><span>Current media</span><strong>{mediaAvailable === null ? 'Checking…' : mediaAvailable ? 'Available for download' : 'Unavailable'}</strong></div><p className="inspector-hint">Validation records the media state at send time; current availability is checked separately.</p></> : (message.trace?.template?.headerFormat === 'DOCUMENT' || template?.components.some((component) => String(component.type).toUpperCase() === 'HEADER' && component.format === 'DOCUMENT')) ? <p className="inspector-hint">No successful document media validation was recorded for this send.</p> : null}</section>}

    {(customerButton || selectedReply) && <section className="inspector-section"><h4>INBOUND INTERACTION</h4><p className="inspector-hint">{customerButton ? 'The customer tapped a legacy reply button.' : interactive?.type === 'list_reply' ? 'The customer selected a row from an interactive list.' : 'The customer tapped an interactive quick reply.'}</p><div className="message-summary-grid action-summary">{(customerButton ? [['Button title', customerButton.text], ['Payload ID', customerButton.payload]] : [['Selected title', selectedReply?.title], ['Reply ID', selectedReply?.id], ...(selectedReply?.description ? [['Description', selectedReply.description]] : [])]).map(([label, value]) => <Fragment key={label}><span>{label}</span><strong>{String(value ?? '—')}</strong></Fragment>)}</div>{contextId && <p className="interaction-context">Reply context: <button onClick={() => onSelectMessage(contextId)}>{contextId}</button></p>}</section>}

    {message.type === 'template' && <section className="inspector-section"><h4>TEMPLATE BUTTON BEHAVIOR</h4>{templateButtons.length ? <div className="button-explanations">{templateButtons.map((button, index) => {
      const kind = String(button.type ?? 'BUTTON').toUpperCase()
      const title = String(button.text ?? button.otp_type ?? `Button ${index + 1}`)
      const destination = kind === 'URL' ? resolveButtonDestination(button, index, message) : ''
      const reference = kind === 'FLOW' ? String(button.flow_id ?? button.flow_name ?? 'Flow reference unavailable') : kind === 'PHONE_NUMBER' ? String(button.phone_number ?? 'Number unavailable') : kind === 'QUICK_REPLY' ? String(button.payload ?? title) : ''
      return <article className="button-explanation" key={`${kind}-${index}`}><div className="button-explanation-heading"><strong>{title}</strong><Badge variant="outline">{kind.replaceAll('_', ' ')}</Badge></div>
        <p>{buttonExplanation(kind)}</p>
        {destination && <div className="button-value"><span>Resolved destination</span><code>{destination}</code></div>}
        {reference && <div className="button-value"><span>{kind === 'QUICK_REPLY' ? 'Reply payload ID' : kind === 'PHONE_NUMBER' ? 'Configured number' : 'Flow reference'}</span><code>{reference}</code></div>}
      </article>
    })}</div> : <p className="inspector-hint">{template ? 'This template has no buttons.' : 'The template definition is unavailable for this sender.'}</p>}</section>}

    {data.relatedMessages.length > 0 && <section className="inspector-section"><h4>RELATED MESSAGES <span className="count">{data.relatedMessages.length}</span></h4><p className="inspector-hint">Messages linked by WhatsApp reply context in this conversation.</p><div className="related-messages">{data.relatedMessages.map((related) => <button className="related-message" key={related.wamid} onClick={() => onSelectMessage(related.wamid)}><span><Link2 />{related.direction === 'in' ? 'Customer reply' : 'Original message'} · {related.type}</span><code>{related.wamid}</code><small>{related.status} · {readableTime(related.createdAt)}</small></button>)}</div></section>}

    {message.direction === 'out' && <section className="inspector-section"><h4>SIMULATE DELIVERY</h4><p className="inspector-hint">Changes local message state and emits a status event. It does not send a WhatsApp message. Configured SNS or webhook destinations may receive the event.</p><div className="actions"><Button variant="outline" onClick={() => void push('delivered')}>Delivered</Button><Button variant="outline" onClick={() => void push('read')}>Read</Button></div><div className="failure-action"><Select value={String(code)} onValueChange={(value) => setCode(Number(value))}><SelectTrigger aria-label="Failure code"><SelectValue /></SelectTrigger><SelectContent>{CODES.map((item) => <SelectItem key={item} value={String(item)}>{item}</SelectItem>)}</SelectContent></Select><Button variant="destructive" onClick={() => void push('failed', code)}>Fail</Button></div></section>}

    <section className="inspector-section"><h4>MESSAGE PAYLOAD</h4><details className="raw-block"><summary>Show raw message JSON</summary><div className="raw-tools">{copyButton('message', message.body)}</div><pre>{pretty(message.body)}</pre></details></section>

    <section className="inspector-section"><h4>STATUS AND EVENT TRACE <span className="count">{timeline.length}</span></h4><p className="inspector-hint">Delivery attempts use the configured SNS endpoint or webhook URL; replaying may send another event to that destination.</p>{timeline.length === 0 ? <p className="inspector-hint">No status transitions or webhook events have been recorded for this message yet.</p> : <ol className="trace-timeline">{timeline.map((entry, index) => <li className={`trace-item ${entry.type}`} key={`${entry.type}-${entry.at}-${index}`}><span className="trace-marker" /><div className="trace-content"><div className="trace-heading"><strong>{entry.title}</strong><time>{readableTime(entry.at)}</time></div>
      {entry.detail && <p>{entry.detail}</p>}
      {entry.event && <><div className="event-identifiers">Event ID <code>{entry.event.id}</code>{eventIdentifiers(entry.event).map((id) => <span key={id}>Message ID <button onClick={() => onSelectMessage(id)}>{id}</button></span>)}</div>
        <div className="event-deliveries">{entry.event.deliveries.length === 0 ? <p>No destinations configured for this event.</p> : entry.event.deliveries.map((delivery, deliveryIndex) => <div className="delivery-result" key={`${delivery.destination}-${deliveryIndex}`}><div className={delivery.ok ? 'ok' : 'bad'}><strong>{delivery.ok ? 'Delivered' : 'Delivery failed'}</strong><span>{delivery.destination}</span><small>{delivery.detail}</small></div>
          {(entry.event?.deliveryAttempts?.find((item) => item.destination === delivery.destination)?.attempts ?? []).map((attempt, attemptIndex) => <div className="delivery-attempt" key={attemptIndex}>{readableTime(attempt.at)} · attempt {attemptIndex + 1} · {attempt.ok ? 'succeeded' : 'failed'} · {attempt.detail}</div>)}
          {!delivery.ok && <Button variant="outline" size="sm" onClick={() => void replay(entry.event!.id, delivery.destination)}>Replay delivery</Button>}
        </div>)}</div>
        <details className="raw-block webhook-raw"><summary>Webhook payload JSON</summary><div className="raw-tools">{copyButton(`webhook-${entry.event.id}`, webhook(entry.event))}</div><pre>{pretty(webhook(entry.event))}</pre></details>
        <details className="raw-block"><summary>AWS event envelope JSON</summary><div className="raw-tools">{copyButton(`envelope-${entry.event.id}`, entry.event.envelope)}</div><pre>{pretty(entry.event.envelope)}</pre></details>
      </>}
    </div></li>)}</ol>}</section>
  </aside>
}
