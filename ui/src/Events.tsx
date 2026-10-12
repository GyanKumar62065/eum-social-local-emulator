import { useEffect, useState } from 'react'
import { api, errorText, type EventRow } from './api.ts'
import { Button } from './components/ui/button.tsx'
function summary(event: EventRow): string {
  const value = JSON.parse(event.envelope.whatsAppWebhookEntry).changes[0].value
  if (value.statuses) return `${value.statuses[0].status} → ${value.statuses[0].recipient_id}${value.statuses[0].errors ? ` (${value.statuses[0].errors[0].code})` : ''}`
  if (value.messages) return `inbound ${value.messages[0].type} from ${value.messages[0].from}`
  return `${value.event} ${value.message_template_name}`
}
export function Events({ tick }: { tick: number }) {
  const [events, setEvents] = useState<EventRow[]>([])
  const [error, setError] = useState('')
  useEffect(() => { api.events().then((result) => setEvents(result.events)).catch(() => {}) }, [tick])
  async function replay(event: EventRow, destination: string) {
    try { const result = await api.replayEvent(event.id, destination); setEvents((current) => current.map((item) => item.id === event.id ? result.event : item)); setError('') }
    catch (failure) { setError(errorText(failure)) }
  }
  return <section className="page"><div className="page-heading"><div><h1>Event log</h1><p>Inspect webhook payloads and local delivery results.</p></div><span className="summary-count">{events.length} recent events</span></div>
    {error && <p className="error-banner">{error}</p>}<table><thead><tr><th>TIME</th><th>EVENT TYPE</th><th>SUMMARY</th><th>DESTINATION DELIVERY</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.at).toLocaleTimeString()}</td><td><span className="kind-pill">{event.kind}</span></td><td>{summary(event)}</td><td>{event.deliveries.length === 0 ? <span className="muted">No destinations configured</span> : event.deliveries.map((delivery, index) => <div key={index} className={delivery.ok ? 'ok' : 'bad'}>{delivery.ok ? '✓' : '×'} &nbsp;{delivery.destination}: {delivery.detail}{event.deliveryAttempts?.find((item) => item.destination === delivery.destination)?.attempts.map((attempt, attemptIndex) => <div className="small muted" key={attemptIndex}>{new Date(attempt.at).toLocaleString()} · {attempt.ok ? 'delivered' : 'failed'} · {attempt.detail}</div>)}{!delivery.ok && <Button variant="outline" size="sm" onClick={() => void replay(event, delivery.destination)}>Retry delivery</Button>}</div>)}</td></tr>)}</tbody></table>
  </section>
}
