import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, errorText, onChange, type Message, type Waba } from './api.ts'
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
  const [view, setView] = useState<View>('inbox'); const [wabas, setWabas] = useState<Waba[]>([]); const [messages, setMessages] = useState<Message[]>([])
  const [threadKey, setThreadKey] = useState<string | null>(null); const [wamid, setWamid] = useState<string | null>(null); const [tick, setTick] = useState(0); const [error, setError] = useState<string | null>(null)
  useEffect(() => { Promise.all([api.wabas(), api.messages()]).then(([wabaResult, messageResult]) => { setWabas(wabaResult.wabas); setMessages(messageResult.messages) }).catch((e) => setError(errorText(e))) }, [tick])
  useEffect(() => onChange(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('eum-social-local-emulator-theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151515' : '#ffffff')
  }, [theme])
  const threads = useMemo(() => groupThreads(messages), [messages]); const thread = threads.find((item) => item.key === threadKey) ?? null
  const threadMessages = useMemo(() => thread ? messages.filter((message) => `${message.phoneNumberId}|${message.peer}` === thread.key).sort((a, b) => a.createdAt - b.createdAt) : [], [messages, thread])
  async function reset() {
    if (!confirm('Delete all messages, events and API-created data, then re-seed from config?')) return
    await api.reset().catch((e) => setError(errorText(e))); setThreadKey(null); setWamid(null)
  }
  return <div class="app">
    <header class="topbar"><div class="brand"><strong>WhatsApp inbox</strong><span>Local simulator</span></div><div class="connection"><i /> Local environment</div>
      <nav>{(['inbox', 'templates', 'events'] as View[]).map((tab) => <button key={tab} class={view === tab ? 'tab active' : 'tab'} onClick={() => setView(tab)}>{tab}</button>)}</nav>
      <button class="theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'Dark mode' : 'Light mode'}</button>
      <button class="reset-button" onClick={reset}><span>↻</span> Reset all</button>
    </header>
    {error && <div class="error" onClick={() => setError(null)}>{error}<span>×</span></div>}
    {view === 'inbox' && <main class="inbox"><Sidebar wabas={wabas} threads={threads} selected={threadKey} onSelect={(key) => { setThreadKey(key); setWamid(null) }} onError={setError} /><ThreadView wabas={wabas} thread={thread} messages={threadMessages} selected={wamid} onSelect={setWamid} onError={setError} /><Inspector wamid={wamid} tick={tick} onError={setError} /></main>}
    {view === 'templates' && <Templates wabas={wabas} tick={tick} onError={setError} />}
    {view === 'events' && <Events tick={tick} />}
  </div>
}
