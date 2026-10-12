import { useEffect, useMemo, useState } from 'react'
import { Moon, RotateCcw, Sun } from 'lucide-react'
import { api, errorText, onChange, type Message, type Template, type Waba } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs.tsx'
import { Events } from './Events.tsx'
import { Inspector } from './Inspector.tsx'
import { Sidebar, type Thread } from './Sidebar.tsx'
import { Templates } from './Templates.tsx'
import { ThreadView } from './Thread.tsx'
type View = 'inbox' | 'templates' | 'events'
function groupThreads(messages: Message[]): Thread[] {
  const map = new Map<string, Thread>()
  for (const message of messages) {
    const key = `${message.phoneNumberId}|${message.peer}`; const thread = map.get(key) ?? { key, phoneNumberId: message.phoneNumberId, peer: message.peer, last: message }
    if (message.createdAt >= thread.last.createdAt) thread.last = message
    map.set(key, thread)
  }
  return [...map.values()].sort((a, b) => b.last.createdAt - a.last.createdAt)
}
export function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('eum-social-local-emulator-theme')
    return saved === 'dark' ? 'dark' : 'light'
  })
  const [view, setView] = useState<View>('inbox'); const [wabas, setWabas] = useState<Waba[]>([]); const [messages, setMessages] = useState<Message[]>([]); const [templates, setTemplates] = useState<Template[]>([])
  const [threadKey, setThreadKey] = useState<string | null>(null); const [wamid, setWamid] = useState<string | null>(null); const [tick, setTick] = useState(0); const [error, setError] = useState<string | null>(null)
  useEffect(() => { Promise.all([api.wabas(), api.messages(), api.templates()]).then(([wabaResult, messageResult, templateResult]) => { setWabas(wabaResult.wabas); setMessages(messageResult.messages); setTemplates(templateResult.templates) }).catch((e) => setError(errorText(e))) }, [tick])
  useEffect(() => onChange(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('eum-social-local-emulator-theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#161b18' : '#ffffff')
  }, [theme])
  const threads = useMemo(() => groupThreads(messages), [messages]); const thread = threads.find((item) => item.key === threadKey) ?? null
  const threadMessages = useMemo(() => thread ? messages.filter((message) => `${message.phoneNumberId}|${message.peer}` === thread.key).sort((a, b) => a.createdAt - b.createdAt) : [], [messages, thread])
  async function reset() {
    if (!confirm('Delete all messages, events and API-created data, then re-seed from config?')) return
    await api.reset().catch((e) => setError(errorText(e))); setThreadKey(null); setWamid(null)
  }
  return <div className="app">
    <header className="topbar"><div className="brand"><strong>WhatsApp inbox</strong><span>Local simulator</span></div><div className="connection"><i /> Local environment</div>
      <Tabs className="top-tabs" value={view} onValueChange={(value) => setView(value as View)}><TabsList aria-label="Main navigation" className="top-tabs-list"><TabsTrigger value="inbox" className="tab">Inbox</TabsTrigger><TabsTrigger value="templates" className="tab">Templates</TabsTrigger><TabsTrigger value="events" className="tab">Events</TabsTrigger></TabsList></Tabs>
      <Button variant="outline" size="sm" className="theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon /> : <Sun />}{theme === 'light' ? 'Dark mode' : 'Light mode'}</Button>
      <Button variant="outline" size="sm" className="reset-button" onClick={reset}><RotateCcw /> Reset all</Button>
    </header>
    {error && <div className="error" onClick={() => setError(null)}>{error}<span>×</span></div>}
    {view === 'inbox' && <main className={`inbox${thread ? ' has-thread' : ''}${wamid ? ' has-selection' : ''}`}><Sidebar wabas={wabas} threads={threads} selected={threadKey} onSelect={(key) => { setThreadKey(key); setWamid(null) }} onError={setError} /><ThreadView wabas={wabas} templates={templates} thread={thread} messages={threadMessages} selected={wamid} onSelect={setWamid} onBack={() => { setThreadKey(null); setWamid(null) }} onError={setError} /><Inspector wamid={wamid} tick={tick} templates={templates} wabas={wabas} onClose={() => setWamid(null)} onError={setError} /></main>}
    {view === 'templates' && <Templates wabas={wabas} tick={tick} onError={setError} />}
    {view === 'events' && <Events tick={tick} />}
  </div>
}
