import { useEffect, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import type { MediaMetadata, Message, Template } from './api.ts'
import { api } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Card } from './components/ui/card.tsx'

type Component = Template['components'][number]
type Button = Record<string, unknown>

function replaceValues(value: unknown, parameters: Record<string, any> = {}): string {
  const text = String(value ?? '')
  return text.replace(/\{\{\s*(\d+|[A-Za-z0-9_]+)\s*\}\}/g, (token, key: string) => {
    const item = /^\d+$/.test(key) ? parameters[Number(key) - 1] : parameters[key]
    return item === undefined ? token : String(item?.text ?? item?.currency?.fallback_value ?? item?.date_time?.fallback_value ?? item?.action?.code ?? item)
  })
}

function parametersFor(message: Message | undefined, type: string, index?: number): Record<string, any> {
  const components = message?.body?.template?.components ?? []
  const match = components.find((item: any) => String(item.type).toUpperCase() === type && (index === undefined || Number(item.index ?? 0) === index))
  return (match?.parameters ?? []).reduce((values: Record<string, any>, item: any, position: number) => {
    values[item.parameter_name ?? position] = item
    return values
  }, {})
}

function componentText(component: Component, message: Message | undefined): string {
  const type = String(component.type).toUpperCase()
  if (message) return replaceValues(component.text, parametersFor(message, type))
  const example = component.example as Record<string, unknown> | undefined
  const raw = type === 'BODY' ? (example?.body_text as unknown[][] | undefined)?.[0] : type === 'HEADER' ? (example?.header_text as unknown[] | undefined) : undefined
  const values = Array.isArray(raw) ? raw.reduce((result: Record<string, unknown>, value, index) => { result[index] = value; return result }, {}) : {}
  return replaceValues(component.text, values)
}

export function resolveButtonDestination(button: Record<string, unknown>, index: number, message: Message | undefined): string {
  const sample = Array.isArray(button.example) ? button.example[0] : undefined
  const parameters = message ? parametersFor(message, 'BUTTON', index) : sample === undefined ? {} : { 0: sample }
  return replaceValues(button.url, parameters)
}

export function TemplatePreview({ template, message, onQuickReply, compact = false }: {
  template: Template
  message?: Message
  onQuickReply?: (button: Button) => void
  compact?: boolean
}) {
  const [openDestination, setOpenDestination] = useState<number | null>(null)
  const [flowPreview, setFlowPreview] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [documentMedia, setDocumentMedia] = useState<MediaMetadata | null>(null)
  const buttonsComponent = template.components.find((component) => ['BUTTONS', 'AUTHENTICATION'].includes(String(component.type).toUpperCase()) && Array.isArray(component.buttons))
  const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons as Button[] : []
  const header = template.components.find((component) => String(component.type).toUpperCase() === 'HEADER')
  const body = template.components.find((component) => String(component.type).toUpperCase() === 'BODY')
  const footer = template.components.find((component) => String(component.type).toUpperCase() === 'FOOTER')
  const auth = template.components.find((component) => String(component.type).toUpperCase() === 'AUTHENTICATION')
  const authBodyExample = body?.example as Record<string, unknown> | undefined
  const authCode = parametersFor(message, 'BODY')[0]?.text ?? (authBodyExample?.body_text as unknown[][] | undefined)?.[0]?.[0] ?? '••••••'
  const document = parametersFor(message, 'HEADER')[0]?.document
  const mediaId = typeof document?.id === 'string' ? document.id : undefined
  const filename = typeof document?.filename === 'string' && document.filename.trim() ? document.filename : message?.trace?.mediaValidation?.filename ?? 'document'
  useEffect(() => {
    let active = true
    if (!mediaId) { setDocumentMedia(message ? { mediaId: '', mimeType: '', size: 0, sha256: '', available: false } : null); return () => { active = false } }
    setDocumentMedia(null)
    api.mediaMetadata(mediaId).then((metadata) => { if (active) setDocumentMedia(metadata) }).catch(() => { if (active) setDocumentMedia({ mediaId, mimeType: '', size: 0, sha256: '', available: false }) })
    return () => { active = false }
  }, [mediaId, message])
  const formatSize = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : bytes >= 1_000 ? `${(bytes / 1_000).toFixed(1)} KB` : `${bytes} B`

  return <Card className={`wa-card${compact ? ' compact' : ''}`}>
    {header && <div className="wa-header">{header.format === 'IMAGE' ? <div className="wa-media-placeholder">Image header</div> : header.format === 'VIDEO' ? <div className="wa-media-placeholder">Video header</div> : header.format === 'DOCUMENT' ? message ? <div className={`wa-document${documentMedia?.available === false ? ' unavailable' : ''}`}>
      <span className="wa-document-icon"><FileText aria-hidden="true" /></span><span className="wa-document-info"><strong title={filename}>{filename}</strong><small>{documentMedia?.available ? `${documentMedia.mimeType} · ${formatSize(documentMedia.size)}` : documentMedia ? 'Attachment unavailable' : 'Loading attachment details…'}</small></span>
      {documentMedia?.available && mediaId ? <a className="wa-document-download" href={`/_eum/api/media/${encodeURIComponent(mediaId)}/download?filename=${encodeURIComponent(filename)}`} download={filename} aria-label={`Download ${filename}`} title={`Download ${filename}`}><Download aria-hidden="true" /></a> : <span className="wa-document-state">{documentMedia ? 'Unavailable' : '…'}</span>}
    </div> : <div className="wa-media-placeholder">Document header · approval sample preview</div> : <strong>{componentText(header, message)}</strong>}</div>}
    {auth && <div className="wa-auth-code"><span>Authentication code</span><strong>{String(authCode)}</strong>{auth.add_security_recommendation === true && <small>For your security, do not share this code.</small>}</div>}
    {body && <div className="wa-body">{componentText(body, message)}</div>}
    {footer && <div className="wa-footer">{componentText(footer, message)}</div>}
    {auth?.code_expiration_minutes !== undefined && <div className="wa-footer">Code expires in {String(auth.code_expiration_minutes)} minutes.</div>}
    {buttons.map((button, index) => {
      const kind = String(button.type ?? 'BUTTON').toUpperCase()
      const label = String(button.text ?? button.otp_type ?? (kind === 'FLOW' ? 'Open flow' : 'Button'))
      if (kind === 'URL') return <div className="wa-action-wrap" key={index}>
        <Button variant="ghost" className="wa-action" onClick={() => setOpenDestination(openDestination === index ? null : index)}>{label}<span aria-hidden="true">↗</span></Button>
        {openDestination === index && <div className="local-action-note"><span>Local link preview</span><code>{resolveButtonDestination(button, index, message) || 'Destination uses template parameters'}</code><small>This preview does not open a browser or contact the destination.</small></div>}
      </div>
      if (kind === 'FLOW') return <div className="wa-action-wrap" key={index}>
        <Button variant="ghost" className="wa-action" onClick={() => setFlowPreview(flowPreview === index ? null : index)}>{label}<span aria-hidden="true">▤</span></Button>
        {flowPreview === index && <div className="local-action-note"><span>Flow preview</span><strong>{String(button.flow_name ?? label)}</strong><small>This template shows the Flow entry point. Flow screens and submission are not simulated.</small></div>}
      </div>
      if (kind === 'QUICK_REPLY') return <Button variant="ghost" className="wa-action" key={index} onClick={() => onQuickReply?.(button)} disabled={!onQuickReply}>{label}</Button>
      if (kind === 'PHONE_NUMBER') return <div className="wa-action static" key={index}>{label}<code>{String(button.phone_number ?? '')}</code></div>
      if (kind === 'COPY_CODE' || kind === 'OTP') return <Button variant="ghost" className="wa-action" key={index} onClick={() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) }}>{copied ? 'Code copied in preview' : label}</Button>
      return <div className="wa-action static" key={index}>{label}</div>
    })}
    {buttons.length === 0 && auth && <Button variant="ghost" className="wa-action" onClick={() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) }}>{copied ? 'Code copied in preview' : 'Copy code'}</Button>}
  </Card>
}

export function previewBody(template: Template): string {
  const body = template.components.find((component) => String(component.type).toUpperCase() === 'BODY')
  return body ? componentText(body, undefined) : template.name
}
