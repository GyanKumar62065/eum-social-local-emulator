import { useEffect, useState } from 'preact/hooks'
import { api, type EventRow } from './api.ts'
function summary(event: EventRow): string {
  const value = JSON.parse(event.envelope.whatsAppWebhookEntry).changes[0].value
  if (value.statuses) return `${value.statuses[0].status} → ${value.statuses[0].recipient_id}${value.statuses[0].errors ? ` (${value.statuses[0].errors[0].code})` : ''}`
  if (value.messages) return `inbound ${value.messages[0].type} from ${value.messages[0].from}`
  return `${value.event} ${value.message_template_name}`
}
export function Events({ tick }: { tick: number }) {
  const [events, setEvents] = useState<EventRow[]>([])
  useEffect(() => { api.events().then((result) => setEvents(result.events)).catch(() => {}) }, [tick])
  return <section class="page"><div class="page-heading"><div><div class="eyebrow">OBSERVABILITY</div><h2>Event log</h2><p>Inspect EUM webhook envelopes and delivery results.</p></div><span class="summary-count">{events.length} recent events</span></div>
    <table><thead><tr><th>TIME</th><th>EVENT TYPE</th><th>SUMMARY</th><th>DESTINATION DELIVERY</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{new Date(event.at).toLocaleTimeString()}</td><td><span class="kind-pill">{event.kind}</span></td><td>{summary(event)}</td><td>{event.deliveries.length === 0 ? <span class="muted">No destinations configured</span> : event.deliveries.map((delivery, index) => <div key={index} class={delivery.ok ? 'ok' : 'bad'}>{delivery.ok ? '✓' : '×'} &nbsp;{delivery.destination}: {delivery.detail}</div>)}</td></tr>)}</tbody></table>
  </section>
}
