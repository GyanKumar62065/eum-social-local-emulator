import { useState } from 'preact/hooks'
import { api, errorText, type Message, type Waba } from './api.ts'
import type { Thread } from './Sidebar.tsx'
const TICKS: Record<string, string> = { accepted: '◷', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!', deleted: '×', warning: '!' }
interface Props { wabas: Waba[]; thread: Thread | null; messages: Message[]; selected: string | null; onSelect: (wamid: string) => void; onError: (error: string) => void }
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
export function ThreadView({ wabas, thread, messages, selected, onSelect, onError }: Props) {
  const [text, setText] = useState('')
  const [replyToSelected, setReplyToSelected] = useState(false)
  const [replyType, setReplyType] = useState<'text' | 'button' | 'button_reply' | 'list_reply'>('text')
  const [interactionId, setInteractionId] = useState('')
  const [interactionTitle, setInteractionTitle] = useState('')
  if (!thread) return <section class="thread-view empty"><div class="empty-mark">✳</div><strong>Your conversations, in one place</strong><span>Select a conversation or send a message as a customer to get started.</span></section>
  const activeThread = thread
  const phone = wabas.flatMap((waba) => waba.phoneNumbers).find((item) => item.id === activeThread.phoneNumberId)
  async function reply(body: string, asType: typeof replyType = replyType) {
    if (!body.trim() && asType === 'text') return
    const quoted = messages.find((message) => message.wamid === selected && message.direction === 'out')
    try {
      if (asType === 'button') await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'button', text: interactionTitle || body, payload: interactionId, ...(replyToSelected && quoted ? { contextMessageId: quoted.wamid } : {}) })
      else if (asType === 'button_reply' || asType === 'list_reply') await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'interactive', interactiveType: asType, id: interactionId, title: interactionTitle || body, ...(asType === 'list_reply' ? { description: body } : {}), ...(replyToSelected && quoted ? { contextMessageId: quoted.wamid } : {}) })
      else await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'text', text: body, ...(replyToSelected && quoted ? { contextMessageId: quoted.wamid } : {}) })
      setText('')
    } catch (error) { onError(errorText(error)) }
  }
  async function sendImage(file: File) { try { await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'image', mediaBase64: await toBase64(file), mimeType: file.type || 'image/jpeg', text: file.name }) } catch (error) { onError(errorText(error)) } }
  return <section class="thread-view">
    <div class="thread-head"><span class="avatar large">{activeThread.peer.slice(-2)}</span><div><strong>{activeThread.peer}</strong><span class="muted">Customer conversation</span></div><div class="thread-business">↔ {phone?.displayName} <span>{phone?.phoneNumber}</span></div></div>
    <div class="thread-date"><span>MESSAGES</span></div>
    <div class="bubbles">{messages.map((message) => <button key={message.wamid} class={`bubble ${message.direction}${message.wamid === selected ? ' selected' : ''}`} onClick={() => onSelect(message.wamid)}>
      {message.type === 'template' && <div class="tag">▧ &nbsp;Template · {message.body?.template?.name}</div>}
      {message.direction === 'in' && message.type === 'image' && message.body?.image?.id && <img src={`/_eum/api/media/${message.body.image.id}`} alt="Customer sent media" />}
      <div class="text">{message.renderedText ?? `[${message.type}]`}</div>
      <div class="meta">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{message.direction === 'out' && <span class={`tick ${message.status}`} title={message.errorCode ? `${message.errorCode} ${message.errorTitle}` : message.status}>{TICKS[message.status] ?? message.status}</span>}</div>
    </button>)}</div>
    <form class="composer" onSubmit={(event) => { event.preventDefault(); void reply(text) }}>
      <label class="file-button" title="Send customer image">＋<input type="file" accept="image/*" onChange={(event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void sendImage(file) }} /></label>
      <select aria-label="Inbound message type" value={replyType} onChange={(event) => setReplyType((event.target as HTMLSelectElement).value as typeof replyType)}><option value="text">Text</option><option value="button">Button</option><option value="button_reply">Button reply</option><option value="list_reply">List reply</option></select>
      {replyType !== 'text' && <><input value={interactionTitle} onInput={(event) => setInteractionTitle((event.target as HTMLInputElement).value)} placeholder="Display title" /><input value={interactionId} onInput={(event) => setInteractionId((event.target as HTMLInputElement).value)} placeholder="Payload / reply ID" /></>}
      <input value={text} onInput={(event) => setText((event.target as HTMLInputElement).value)} placeholder={`Reply as ${activeThread.peer}…`} />
      {messages.some((message) => message.wamid === selected && message.direction === 'out') && <label class="context-toggle"><input type="checkbox" checked={replyToSelected} onChange={(event) => setReplyToSelected((event.target as HTMLInputElement).checked)} /> Quote selected</label>}
      <button type="button" class="stop-button" onClick={() => void reply('STOP', 'text')}>Send STOP</button><button type="submit" class="primary send-button">Send <span>↗</span></button>
    </form>
  </section>
}
