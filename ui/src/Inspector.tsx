import { useEffect, useState } from 'preact/hooks'
import { api, errorText, type MessageDetail } from './api.ts'
const CODES = [131026, 131047, 131049, 131050, 132000, 132001]
export function Inspector({ wamid, tick, onError }: { wamid: string | null; tick: number; onError: (error: string) => void }) {
  const [data, setData] = useState<MessageDetail | null>(null); const [code, setCode] = useState(131026)
  useEffect(() => { if (!wamid) { setData(null); return }; api.message(wamid).then(setData).catch((error) => onError(errorText(error))) }, [wamid, tick])
  if (!data) return <aside class="inspector empty-inspector"><div class="inspect-icon">⌕</div><strong>Message details</strong><span>Select a message to inspect its payload, status history and delivery events.</span></aside>
  const message = data.message
  const push = (status: string, failureCode?: number) => api.setStatus(message.wamid, status, failureCode).catch((error) => onError(errorText(error)))
  return <aside class="inspector">
    <div class="inspector-title"><span class="inspect-icon">⌕</span><div><strong>Message details</strong><span>Delivery inspector</span></div></div>
    <div class="detail-card"><div class="detail-label">MESSAGE ID</div><code>{message.wamid}</code>{message.awsMessageId && <><div class="detail-label spaced">AWS MESSAGE ID</div><code>{message.awsMessageId}</code></>}<div class="detail-label spaced">CURRENT STATUS</div><div class={`status-pill ${message.status}`}>{message.status === 'read' ? '✓✓' : message.status === 'failed' ? '!' : '●'} &nbsp;{message.status}{message.errorCode ? ` · ${message.errorCode}` : ''}</div></div>
    {message.direction === 'out' && <section class="inspector-section"><h4>SIMULATE DELIVERY</h4><div class="actions"><button onClick={() => void push('delivered')}>Delivered</button><button onClick={() => void push('read')}>Read</button></div><div class="failure-action"><select value={code} onChange={(event) => setCode(Number((event.target as HTMLSelectElement).value))}>{CODES.map((item) => <option key={item} value={item}>{item}</option>)}</select><button class="fail-button" onClick={() => void push('failed', code)}>Fail</button></div></section>}
    <section class="inspector-section"><h4>REQUEST PAYLOAD</h4><pre>{JSON.stringify(message.body, null, 2)}</pre></section>
    <section class="inspector-section"><h4>STATUS HISTORY</h4><ol class="history">{data.history.map((item, index) => <li key={index}><span class="history-dot" /><div><strong>{item.status}</strong>{item.errorCode && <small>{item.errorCode}</small>}</div><time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol></section>
    <section class="inspector-section"><h4>DELIVERY EVENTS <span class="count">{data.events.length}</span></h4>{data.events.map((event) => <details class="event-detail" key={event.id}><summary>{event.kind}<span>{event.deliveries.map((delivery) => delivery.ok ? '✓' : '×').join(' ') || 'No destinations'}</span></summary>{event.deliveries.map((delivery, index) => <div class={delivery.ok ? 'ok' : 'bad'} key={index}>{delivery.destination}: {delivery.detail}</div>)}<pre>{JSON.stringify({ ...event.envelope, whatsAppWebhookEntry: JSON.parse(event.envelope.whatsAppWebhookEntry) }, null, 2)}</pre></details>)}</section>
  </aside>
}
