import { useEffect, useState } from 'preact/hooks'
import { api, errorText, type Template, type Waba } from './api.ts'
function previewText(component: Record<string, unknown>): string | undefined {
  if (typeof component.text !== 'string') return undefined
  const type = String(component.type).toUpperCase()
  const example = component.example as Record<string, unknown> | undefined
  const exampleValues = type === 'BODY' ? (example?.body_text as unknown[][] | undefined)?.[0] : type === 'HEADER' ? (example?.header_text as unknown[] | undefined) : undefined
  return component.text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, number: string) => String(exampleValues?.[Number(number) - 1] ?? whole))
}
function buttonUrl(button: Record<string, unknown>): string | undefined {
  let raw = String(button.url ?? '')
  const examples = button.example
  const sample = Array.isArray(examples) ? examples[0] : typeof examples === 'string' ? examples : undefined
  if (sample !== undefined) raw = raw.replace(/\{\{\s*\d+\s*\}\}/g, String(sample))
  if (!raw || raw.includes('{{')) return undefined
  try { const url = new URL(raw); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}
export function Templates({ wabas, tick, onError }: { wabas: Waba[]; tick: number; onError: (error: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  useEffect(() => { api.templates().then((result) => setTemplates(result.templates)).catch((error) => onError(errorText(error))) }, [tick])
  const wabaName = (id: string) => wabas.find((waba) => waba.id === id)?.name ?? id
  const act = (promise: Promise<unknown>) => promise.catch((error) => onError(errorText(error)))
  return <section class="page"><div class="page-heading"><div><div class="eyebrow">CONTENT MANAGEMENT</div><h2>Message templates</h2><p>Review simulated WhatsApp templates and control their approval state.</p></div><span class="summary-count">{templates.length} templates</span></div>
    <table><thead><tr><th>BUSINESS ACCOUNT</th><th>TEMPLATE</th><th>LANGUAGE</th><th>CATEGORY</th><th>STATUS</th><th>BODY PREVIEW</th><th>ACTIONS</th></tr></thead><tbody>
      {templates.map((template) => <tr key={template.metaTemplateId}><td>{wabaName(template.wabaId)}</td><td><strong>{template.name}</strong><div class="small muted">{template.metaTemplateId} · generation {template.generation ?? 1}</div>{template.rejectionReason && <div class="small">Rejection: {template.rejectionReason}</div>}</td><td>{template.language}</td><td>{template.category}</td><td><span class={`badge ${template.status.toLowerCase()}`}>{template.status}</span></td><td class="body">{template.components.map((component, index) => { const type = String(component.type).toUpperCase(); const buttonList = Array.isArray(component.buttons) ? component.buttons as Record<string, unknown>[] : []; return <div key={index}><span class="small muted">{type}</span>{previewText(component) && <div>{previewText(component)}</div>}{type === 'AUTHENTICATION' && <div>{component.add_security_recommendation ? 'Security recommendation enabled. ' : ''}{component.code_expiration_minutes !== undefined ? `Code expires in ${String(component.code_expiration_minutes)} minutes.` : ''}</div>}{buttonList.map((button, buttonIndex) => { const url = buttonUrl(button); return <div key={buttonIndex}>{String(button.text ?? button.type)}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Open URL</a></>}</div> })}</div> })}</td><td class="actions">{template.status !== 'APPROVED' && <button onClick={() => void act(api.approve(template.metaTemplateId, template.generation ?? 1))}>Approve</button>}{template.status !== 'REJECTED' && <button class="fail-button" onClick={() => { const reason = prompt('Rejection reason', 'INVALID_FORMAT'); if (reason !== null) void act(api.reject(template.metaTemplateId, reason, template.generation ?? 1)) }}>Reject</button>}{template.status === 'APPROVED' && <button onClick={() => void act(api.setTemplateState(template.metaTemplateId, 'pause', template.generation ?? 1))}>Pause</button>}{template.status !== 'DISABLED' && <button onClick={() => void act(api.setTemplateState(template.metaTemplateId, 'disable', template.generation ?? 1))}>Disable</button>}</td></tr>)}
    </tbody></table>
  </section>
}
