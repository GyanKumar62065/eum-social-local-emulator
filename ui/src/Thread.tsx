import { useState } from 'react'
import { ArrowLeft, Paperclip, Send } from 'lucide-react'
import { api, errorText, type Message, type Template, type Waba } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { TemplatePreview } from './TemplatePreview.tsx'
import type { Thread } from './Sidebar.tsx'

const TICKS: Record<string, string> = { accepted: '◷', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!', deleted: '×', warning: '!' }
interface Props { wabas: Waba[]; templates: Template[]; thread: Thread | null; messages: Message[]; selected: string | null; onSelect: (wamid: string) => void; onBack: () => void; onError: (error: string) => void }
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })

export function ThreadView({ wabas, templates, thread, messages, selected, onSelect, onBack, onError }: Props) {
  const [text, setText] = useState('')
  const [replyToSelected, setReplyToSelected] = useState(false)
  const [replyType, setReplyType] = useState<'text' | 'button' | 'button_reply' | 'list_reply'>('text')
  const [interactionId, setInteractionId] = useState('')
  const [interactionTitle, setInteractionTitle] = useState('')
  if (!thread) return <section className="thread-view empty"><div className="empty-mark">▤</div><strong>Your inbox is ready</strong><span>Choose a conversation, or simulate an inbound message to create one.</span></section>

  const activeThread = thread
  const phone = wabas.flatMap((waba) => waba.phoneNumbers).find((item) => item.id === activeThread.phoneNumberId)
  const templateFor = (message: Message) => {
    const snapshot = message.trace?.template
    if (snapshot?.components) return { metaTemplateId: `snapshot-${message.wamid}`, wabaId: phone?.wabaId ?? '', name: snapshot.name, language: snapshot.language, category: 'UTILITY', status: 'APPROVED', generation: snapshot.generation ?? 0, components: snapshot.components }
    return templates.find((template) => template.wabaId === phone?.wabaId && template.name === message.body?.template?.name && template.language === message.body?.template?.language?.code)
  }

  async function reply(body: string, asType: typeof replyType = replyType, contextMessageId?: string) {
    if (!body.trim() && asType === 'text') return
    if (asType !== 'text' && (!interactionTitle.trim() || !interactionId.trim())) return
    const quoted = messages.find((message) => message.wamid === selected && message.direction === 'out')
    const context = contextMessageId ?? (replyToSelected ? quoted?.wamid : undefined)
    try {
      if (asType === 'button') await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'button', text: interactionTitle || body, payload: interactionId, ...(context ? { contextMessageId: context } : {}) })
      else if (asType === 'button_reply' || asType === 'list_reply') await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'interactive', interactiveType: asType, id: interactionId, title: interactionTitle || body, ...(asType === 'list_reply' ? { description: body } : {}), ...(context ? { contextMessageId: context } : {}) })
      else await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'text', text: body, ...(context ? { contextMessageId: context } : {}) })
      setText('')
    } catch (error) { onError(errorText(error)) }
  }
  async function sendImage(file: File) { try { await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'image', mediaBase64: await toBase64(file), mimeType: file.type || 'image/jpeg', text: file.name }) } catch (error) { onError(errorText(error)) } }
  async function quickReply(button: Record<string, unknown>, contextMessageId: string) {
    const title = String(button.text ?? 'Reply')
    try { await api.inbound({ phoneNumberId: activeThread.phoneNumberId, from: activeThread.peer, type: 'interactive', interactiveType: 'button_reply', id: String(button.payload ?? title), title, contextMessageId }) }
    catch (error) { onError(errorText(error)) }
  }

  return <section className="thread-view">
    <div className="thread-head"><Button variant="ghost" size="sm" className="back-to-inbox" onClick={onBack}><ArrowLeft /> Inbox</Button><span className="avatar large">{activeThread.peer.slice(-2)}</span><div className="contact-name"><strong>{activeThread.peer}</strong><span className="muted">WhatsApp conversation</span></div><div className="thread-business"><strong>{phone?.displayName}</strong><span>{phone?.phoneNumber}</span></div></div>
    <div className="thread-date"><span>Conversation</span></div>
    <div className="bubbles">{messages.map((message) => {
      const template = message.type === 'template' ? templateFor(message) : undefined
      return <article key={message.wamid} className={`bubble ${message.direction}${message.wamid === selected ? ' selected' : ''}`}>
        <div className="bubble-top"><span>{message.direction === 'out' ? 'Business' : 'Customer'}<span className="message-kind">{message.type === 'template' ? 'Template' : message.type}</span></span><Button variant="ghost" size="sm" className="message-details" aria-label={`View details for ${message.type} message ${message.wamid}`} onClick={() => onSelect(message.wamid)}>{message.wamid === selected ? 'Selected' : 'View details'}</Button></div>
        {message.direction === 'in' && message.type === 'image' && message.body?.image?.id && <img src={`/_eum/api/media/${message.body.image.id}`} alt="Customer sent media" />}
        {message.type === 'template' && template
          ? <TemplatePreview template={template} message={message} compact onQuickReply={(button) => void quickReply(button, message.wamid)} />
          : <div className="text">{message.renderedText ?? `[${message.type}]`}{message.type === 'template' && <small className="template-unavailable">Template definition is not available for this sender.</small>}</div>}
        <div className="meta"><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{message.direction === 'out' && <span className={`tick ${message.status}`} title={message.errorCode ? `${message.errorCode} ${message.errorTitle}` : message.status}>{TICKS[message.status] ?? message.status}</span>}</div>
      </article>
    })}</div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); void reply(text) }}>
      <div className="composer-caption"><span>Simulate a customer reply</span><span>Sent to {activeThread.peer}</span></div>
      <div className="composer-row">
        <Button variant="outline" size="icon" className="file-button" asChild><label title="Attach customer image"><Paperclip /><input type="file" accept="image/*" aria-label="Attach customer image" onChange={(event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void sendImage(file) }} /></label></Button>
        <Input className="reply-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={`Write a message as ${activeThread.peer}`} />
        <Button type="submit" variant="default" className="send-button" disabled={replyType === 'text' ? !text.trim() : !interactionTitle.trim() || !interactionId.trim()}>Send reply <Send /></Button>
      </div>
      <div className="composer-options">
        <label>Message type<Select value={replyType} onValueChange={(value) => setReplyType(value as typeof replyType)}><SelectTrigger className="reply-select-trigger"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">Text</SelectItem><SelectItem value="button">Button payload</SelectItem><SelectItem value="button_reply">Quick reply</SelectItem><SelectItem value="list_reply">List selection</SelectItem></SelectContent></Select></label>
        {replyType !== 'text' && <><label>{replyType === 'list_reply' ? 'Row title' : 'Button title'}<Input value={interactionTitle} onChange={(event) => setInteractionTitle(event.target.value)} placeholder={replyType === 'list_reply' ? 'e.g. Delivery options' : 'e.g. Track order'} /></label><label>Reply ID<Input value={interactionId} onChange={(event) => setInteractionId(event.target.value)} placeholder="e.g. track_order" /></label></>}
        {messages.some((message) => message.wamid === selected && message.direction === 'out') && <label className="context-toggle"><input type="checkbox" checked={replyToSelected} onChange={(event) => setReplyToSelected((event.target as HTMLInputElement).checked)} /> Reply to selected message</label>}
        <Button type="button" variant="outline" className="stop-button" onClick={() => void reply('STOP', 'text')}>Send STOP</Button>
      </div>
      <p className="message-type-help" aria-live="polite">{{
        text: 'Text sends a normal inbound customer message.',
        button: 'Button payload sends a legacy button tap with the title and payload ID you enter.',
        button_reply: 'Quick reply simulates a customer tapping a WhatsApp reply button. The title and reply ID are recorded on the inbound message.',
        list_reply: 'List selection simulates a customer choosing a row. The title and reply ID identify the selected row; the message field is an optional description.',
      }[replyType]}</p>
    </form>
  </section>
}
