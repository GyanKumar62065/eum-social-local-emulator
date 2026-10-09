import { useState } from 'preact/hooks'
import { api, errorText, type Message, type Waba } from './api.ts'
export interface Thread { key: string; phoneNumberId: string; peer: string; last: Message }
interface Props { wabas: Waba[]; threads: Thread[]; selected: string | null; onSelect: (key: string) => void; onError: (error: string) => void }
export function Sidebar({ wabas, threads, selected, onSelect, onError }: Props) {
  const phones = wabas.flatMap((waba) => waba.phoneNumbers); const [phoneId, setPhoneId] = useState(''); const [from, setFrom] = useState('+919800001234'); const [text, setText] = useState('Hi, I have a question about my invoice')
  const target = phoneId || phones[0]?.id || ''
  async function start(event: Event) {
    event.preventDefault()
    try { const { message } = await api.inbound({ phoneNumberId: target, from, type: 'text', text }); onSelect(`${message.phoneNumberId}|${message.peer}`) }
    catch (error) { onError(errorText(error)) }
  }
  return <aside class="sidebar">
    <div class="section-label">WORKSPACE</div>
    {wabas.map((waba) => <section class="account" key={waba.id}><h3 title={waba.id}><span class="account-icon">◉</span>{waba.name}<span class="badge">{waba.registrationStatus}</span></h3>
      {waba.phoneNumbers.map((phone) => <div key={phone.id} class="phone"><div class="phone-head"><span class="phone-icon">▣</span><span>{phone.displayName}</span><small>{phone.phoneNumber}</small></div><code class="small phone-id">{phone.id}</code>
        {threads.filter((thread) => thread.phoneNumberId === phone.id).map((thread) => <button key={thread.key} class={thread.key === selected ? 'thread active' : 'thread'} onClick={() => onSelect(thread.key)}><span class="avatar">{thread.peer.slice(-2)}</span><span class="thread-copy"><strong>{thread.peer}</strong><span class="muted ellipsis">{thread.last.renderedText ?? thread.last.type}</span></span><span class="thread-time">{new Date(thread.last.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></button>)}
      </div>)}
    </section>)}
    <form class="new-thread" onSubmit={start}><div class="form-title"><span>＋</span><h4>Message as a customer</h4></div>
      <label>Business number<select value={target} onChange={(event) => setPhoneId((event.target as HTMLSelectElement).value)}>{phones.map((phone) => <option key={phone.id} value={phone.id}>{phone.displayName} · {phone.phoneNumber}</option>)}</select></label>
      <label>Customer number<input value={from} onInput={(event) => setFrom((event.target as HTMLInputElement).value)} placeholder="+919800001234" /></label>
      <label>Message<input value={text} onInput={(event) => setText((event.target as HTMLInputElement).value)} /></label>
      <button class="primary" type="submit" disabled={!target}>Send inbound message <span>↗</span></button>
    </form>
    <div class="sidebar-foot"><span class="pulse" /> Connected to local simulator</div>
  </aside>
}
