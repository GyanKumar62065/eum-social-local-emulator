import { Fragment, useEffect, useState } from 'react'
import { Badge } from './components/ui/badge.tsx'
import { Button } from './components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { api, errorText, type MessageDetail, type Template, type Waba } from './api.ts'
const CODES = [131026, 131047, 131049, 131050, 132000, 132001]
const buttonHelp: Record<string, string> = {
  URL: 'Shows a local destination preview. It does not open a browser or contact the URL.',
  FLOW: 'Shows the Flow entry point. Flow screens and submissions are not simulated.',
  QUICK_REPLY: 'Tap it in the inbox preview to add a matching inbound customer reply.',
  PHONE_NUMBER: 'Displays the configured number. The local preview does not place a call.',
  COPY_CODE: 'Shows a local copy confirmation; it does not access the clipboard.',
  OTP: 'Shows a local authentication-code action for preview.',
}
export function Inspector({ wamid, tick, templates, wabas, onClose, onError }: { wamid: string | null; tick: number; templates: Template[]; wabas: Waba[]; onClose: () => void; onError: (error: string) => void }) {
  const [data, setData] = useState<MessageDetail | null>(null); const [code, setCode] = useState(131026)
  useEffect(() => { if (!wamid) { setData(null); return }; api.message(wamid).then(setData).catch((error) => onError(errorText(error))) }, [wamid, tick])
  if (!data) return <aside className="inspector empty-inspector"><div className="inspect-icon">⌕</div><strong>Message details</strong><span>Select a message to inspect its payload, status history and delivery events.</span></aside>
  const message = data.message
  const phone = wabas.flatMap((waba) => waba.phoneNumbers).find((item) => item.id === message.phoneNumberId)
  const templateName = message.body?.template?.name
  const template = message.type === 'template' ? templates.find((item) => item.wabaId === phone?.wabaId && item.name === templateName && item.language === message.body?.template?.language?.code) : undefined
  const templateButtons = template?.components.flatMap((component) => Array.isArray(component.buttons) ? component.buttons as Record<string, unknown>[] : []) ?? []
  const messageKind = message.type === 'interactive' ? String(message.body?.interactive?.type ?? message.body?.interactiveType ?? 'interactive reply').replaceAll('_', ' ') : message.type.replaceAll('_', ' ')
  const customerButton = message.body?.button
  const interactive = message.body?.interactive
  const selectedReply = interactive?.button_reply ?? interactive?.list_reply
  const push = (status: string, failureCode?: number) => api.setStatus(message.wamid, status, failureCode).catch((error) => onError(errorText(error)))
  async function replay(eventId: string, destination: string) {
    try { const result = await api.replayEvent(eventId, destination); setData((current) => current ? { ...current, events: current.events.map((event) => event.id === eventId ? result.event : event) } : current) }
    catch (error) { onError(errorText(error)) }
  }
  return <aside className="inspector">
    <div className="inspector-title"><span className="inspect-icon">⌕</span><div><strong>Message details</strong><span>Delivery inspector</span></div><Button variant="ghost" size="icon" className="inspector-close" aria-label="Close message details" onClick={onClose}>×</Button></div>
    <div className="detail-card"><div className="detail-label">MESSAGE</div><strong className="message-summary-title">{message.direction === 'out' ? 'Business to customer' : 'Customer to business'}</strong><div className="message-summary-grid"><span>Type</span><strong>{messageKind}{templateName ? ` · ${templateName}` : ''}</strong><span>From</span><strong>{message.direction === 'out' ? phone?.phoneNumber ?? 'Business number' : message.peer}</strong><span>To</span><strong>{message.direction === 'out' ? message.peer : phone?.phoneNumber ?? 'Business number'}</strong><span>Sent</span><strong>{new Date(message.createdAt).toLocaleString()}</strong></div><div className="detail-label spaced">CURRENT STATUS</div><Badge variant={message.status === 'failed' ? 'destructive' : 'secondary'} className={`status-pill ${message.status}`}>{message.status === 'read' ? '✓✓' : message.status === 'failed' ? '!' : '●'} &nbsp;{message.status}{message.errorCode ? ` · ${message.errorCode}` : ''}</Badge><details className="message-id-detail"><summary>Show message IDs</summary><code>{message.wamid}</code>{message.awsMessageId && <code>{message.awsMessageId}</code>}</details></div>
    {message.renderedText && <section className="inspector-section"><h4>MESSAGE CONTENT</h4><p className="inspector-message-content">{message.renderedText}</p></section>}
    {(customerButton || selectedReply) && <section className="inspector-section"><h4>CUSTOMER ACTION</h4><p className="inspector-hint">{customerButton ? 'The customer tapped a legacy button in the message.' : interactive?.type === 'list_reply' ? 'The customer selected a row from an interactive list.' : 'The customer tapped an interactive quick reply.'}</p><div className="message-summary-grid action-summary">{(customerButton ? [['Button', customerButton.text], ['Payload ID', customerButton.payload]] : [['Selection', selectedReply?.title], ['Reply ID', selectedReply?.id], ...(selectedReply?.description ? [['Description', selectedReply.description]] : [])]).map(([label, value]) => <Fragment key={label}><span>{label}</span><strong>{String(value ?? '—')}</strong></Fragment>)}</div></section>}
    {message.type === 'template' && <section className="inspector-section"><h4>TEMPLATE BUTTONS</h4>{templateButtons.length ? <div className="button-explanations">{templateButtons.map((button, index) => { const kind = String(button.type ?? 'BUTTON').toUpperCase(); const title = String(button.text ?? button.otp_type ?? `Button ${index + 1}`); return <div className="button-explanation" key={`${kind}-${index}`}><strong>{title}</strong><span>{kind.replaceAll('_', ' ')}</span><p>{buttonHelp[kind] ?? 'Shown as a non-interactive button in this local preview.'}</p></div> })}</div> : <p className="inspector-hint">{template ? 'This template has no buttons.' : 'The template definition is unavailable for this sender.'}</p>}</section>}
    {message.direction === 'out' && <section className="inspector-section"><h4>SIMULATE DELIVERY</h4><div className="actions"><Button variant="outline" onClick={() => void push('delivered')}>Delivered</Button><Button variant="outline" onClick={() => void push('read')}>Read</Button></div><div className="failure-action"><Select value={String(code)} onValueChange={(value) => setCode(Number(value))}><SelectTrigger aria-label="Failure code"><SelectValue /></SelectTrigger><SelectContent>{CODES.map((item) => <SelectItem key={item} value={String(item)}>{item}</SelectItem>)}</SelectContent></Select><Button variant="destructive" onClick={() => void push('failed', code)}>Fail</Button></div></section>}
    <section className="inspector-section"><details className="payload-detail"><summary>Show raw message payload</summary><pre>{JSON.stringify(message.body, null, 2)}</pre></details></section>
    <section className="inspector-section"><h4>STATUS HISTORY</h4><ol className="history">{data.history.map((item, index) => <li key={index}><span className="history-dot" /><div><strong>{item.status}</strong>{item.errorCode && <small>{item.errorCode}</small>}</div><time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol></section>
    <section className="inspector-section"><h4>DELIVERY EVENTS <span className="count">{data.events.length}</span></h4>{data.events.map((event) => <details className="event-detail" key={event.id}><summary>{event.kind}<span>{event.deliveries.map((delivery) => delivery.ok ? '✓' : '×').join(' ') || 'No destinations'}</span></summary>{event.deliveries.map((delivery, index) => <div className={delivery.ok ? 'ok' : 'bad'} key={index}>{delivery.destination}: {delivery.detail}{event.deliveryAttempts?.find((item) => item.destination === delivery.destination)?.attempts.map((attempt, attemptIndex) => <div className="small muted" key={attemptIndex}>{new Date(attempt.at).toLocaleString()} · {attempt.ok ? 'delivered' : 'failed'} · {attempt.detail}</div>)}{!delivery.ok && <Button variant="outline" size="sm" onClick={() => void replay(event.id, delivery.destination)}>Retry delivery</Button>}</div>)}<pre>{JSON.stringify({ ...event.envelope, whatsAppWebhookEntry: JSON.parse(event.envelope.whatsAppWebhookEntry) }, null, 2)}</pre></details>)}</section>
  </aside>
}
