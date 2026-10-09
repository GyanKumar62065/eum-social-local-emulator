import { useEffect, useState } from 'preact/hooks'
import { api, errorText, type Template, type Waba } from './api.ts'
export function Templates({ wabas, tick, onError }: { wabas: Waba[]; tick: number; onError: (error: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  useEffect(() => { api.templates().then((result) => setTemplates(result.templates)).catch((error) => onError(errorText(error))) }, [tick])
  const wabaName = (id: string) => wabas.find((waba) => waba.id === id)?.name ?? id
  const act = (promise: Promise<unknown>) => promise.catch((error) => onError(errorText(error)))
  return <section class="page"><div class="page-heading"><div><div class="eyebrow">CONTENT MANAGEMENT</div><h2>Message templates</h2><p>Review simulated WhatsApp templates and control their approval state.</p></div><span class="summary-count">{templates.length} templates</span></div>
    <table><thead><tr><th>BUSINESS ACCOUNT</th><th>TEMPLATE</th><th>LANGUAGE</th><th>CATEGORY</th><th>STATUS</th><th>BODY PREVIEW</th><th>ACTIONS</th></tr></thead><tbody>
      {templates.map((template) => <tr key={template.metaTemplateId}><td>{wabaName(template.wabaId)}</td><td><strong>{template.name}</strong><div class="small muted">{template.metaTemplateId}</div></td><td>{template.language}</td><td>{template.category}</td><td><span class={`badge ${template.status.toLowerCase()}`}>{template.status}</span></td><td class="body">{template.components.find((component) => String(component.type).toUpperCase() === 'BODY')?.text}</td><td class="actions">{template.status !== 'APPROVED' && <button onClick={() => void act(api.approve(template.metaTemplateId))}>Approve</button>}{template.status !== 'REJECTED' && <button class="fail-button" onClick={() => void act(api.reject(template.metaTemplateId, prompt('Rejection reason', 'INVALID_FORMAT') ?? 'INVALID_FORMAT'))}>Reject</button>}</td></tr>)}
    </tbody></table>
  </section>
}
