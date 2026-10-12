import { useMemo, useState, type FormEvent } from 'react'
import { MessageSquarePlus, Search } from 'lucide-react'
import { api, errorText, type Message, type Waba } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { Input } from './components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'

export interface Thread { key: string; phoneNumberId: string; peer: string; last: Message }
interface Props { wabas: Waba[]; threads: Thread[]; selected: string | null; onSelect: (key: string) => void; onError: (error: string) => void }

export function Sidebar({ wabas, threads, selected, onSelect, onError }: Props) {
  const phones = wabas.flatMap((waba) => waba.phoneNumbers)
  const [phoneId, setPhoneId] = useState('')
  const [from, setFrom] = useState('+919800001234')
  const [text, setText] = useState('Hi, I have a question about my invoice')
  const [search, setSearch] = useState('')
  const [showSimulator, setShowSimulator] = useState(false)
  const target = phoneId || phones[0]?.id || ''
  const visibleThreads = useMemo(() => threads.filter((thread) => `${thread.peer} ${thread.last.renderedText ?? ''}`.toLowerCase().includes(search.toLowerCase())), [threads, search])

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const { message } = await api.inbound({ phoneNumberId: target, from, type: 'text', text })
      onSelect(`${message.phoneNumberId}|${message.peer}`)
      setShowSimulator(false)
    } catch (error) { onError(errorText(error)) }
  }

  return <aside className="sidebar">
    <div className="sidebar-heading"><div><h2>Inbox</h2><span>{threads.length} conversations</span></div><Button variant="outline" size="sm" className="simulate-button" onClick={() => setShowSimulator(true)} disabled={!phones.length}><MessageSquarePlus /> Simulate inbound</Button></div>
    <label className="thread-search"><Search aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
    <div className="thread-list">
      {wabas.map((waba) => <section className="account" key={waba.id}><h3 title={waba.id}><span className="account-icon">◉</span>{waba.name}<span className="account-status" title={waba.registrationStatus} /></h3>
        {waba.phoneNumbers.map((phone) => {
          const phoneThreads = visibleThreads.filter((thread) => thread.phoneNumberId === phone.id)
          return <div key={phone.id} className="phone-group"><div className="phone-group-name">{phone.displayName}<span>{phone.phoneNumber}</span></div>
            {phoneThreads.map((thread) => <Button variant="ghost" key={thread.key} className={thread.key === selected ? 'thread active' : 'thread'} onClick={() => onSelect(thread.key)}><span className="avatar">{thread.peer.slice(-2)}</span><span className="thread-copy"><strong>{thread.peer}</strong><span className="muted ellipsis">{thread.last.renderedText ?? thread.last.type}</span></span><time className="thread-time">{new Date(thread.last.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></Button>)}
          </div>
        })}
      </section>)}
      {visibleThreads.length === 0 && <div className="thread-empty">{search ? 'No conversations match that search.' : 'No conversations yet. Simulate an inbound message to start one.'}</div>}
    </div>
    <div className="sidebar-foot"><span className="pulse" /> Connected to local simulator</div>
    <Dialog open={showSimulator} onOpenChange={setShowSimulator}><DialogContent className="simulator-modal">
      <DialogHeader className="modal-heading"><div><DialogTitle>Simulate inbound message</DialogTitle><DialogDescription>Create a customer message in the local inbox.</DialogDescription></div></DialogHeader>
      <form className="simulator-form" onSubmit={(event) => void start(event)}>
        <label>Business number<Select value={target} onValueChange={setPhoneId}><SelectTrigger><SelectValue placeholder="Choose a sender" /></SelectTrigger><SelectContent>{phones.map((phone) => <SelectItem key={phone.id} value={phone.id}>{phone.displayName} · {phone.phoneNumber}</SelectItem>)}</SelectContent></Select></label>
        <label>Customer number<Input value={from} onChange={(event) => setFrom(event.target.value)} placeholder="+1 555 000 1234" /></label>
        <label>Message<Input value={text} onChange={(event) => setText(event.target.value)} /></label>
        <div className="modal-actions"><Button type="button" variant="outline" onClick={() => setShowSimulator(false)}>Cancel</Button><Button variant="default" type="submit" disabled={!target || !from.trim() || !text.trim()}>Create conversation</Button></div>
      </form>
    </DialogContent></Dialog>
  </aside>
}
