import { useEffect, useMemo, useState } from 'react'
import { Badge } from './components/ui/badge.tsx'
import { Button } from './components/ui/button.tsx'
import { Card } from './components/ui/card.tsx'
import { Input } from './components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { api, errorText, type Template, type Waba } from './api.ts'
import { previewBody, TemplatePreview } from './TemplatePreview.tsx'

export function Templates({ wabas, tick, onError }: { wabas: Waba[]; tick: number; onError: (error: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  useEffect(() => { api.templates().then((result) => { setTemplates(result.templates); setSelectedId((current) => current ?? result.templates[0]?.metaTemplateId ?? null) }).catch((error) => onError(errorText(error))) }, [tick])
  const filtered = useMemo(() => templates.filter((template) => (statusFilter === 'ALL' || template.status === statusFilter) && `${template.name} ${template.category} ${template.language}`.toLowerCase().includes(search.toLowerCase())), [templates, search, statusFilter])
  const selected = filtered.find((template) => template.metaTemplateId === selectedId) ?? filtered[0]
  const wabaName = (id: string) => wabas.find((waba) => waba.id === id)?.name ?? id
  const act = (promise: Promise<unknown>) => promise.catch((error) => onError(errorText(error)))

  return <section className="page templates-page">
    <div className="page-heading"><div><h1>Message templates</h1><p>Review the content and buttons your local sender can use.</p></div><span className="summary-count">{templates.length} templates</span></div>
    <Card className="template-workspace">
      <section className="template-browser" aria-label="Template library">
        <div className="template-filters"><label className="template-search"><span aria-hidden="true">⌕</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a template" aria-label="Find a template" /></label><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger aria-label="Filter by status" className="template-status-trigger"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All statuses</SelectItem>{[...new Set(templates.map((template) => template.status))].sort().map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}</SelectContent></Select></div>
        <div className="template-list">{filtered.map((template) => <Button variant="ghost" key={template.metaTemplateId} className={`template-row${template.metaTemplateId === selected?.metaTemplateId ? ' active' : ''}`} onClick={() => setSelectedId(template.metaTemplateId)}>
          <span className={`status-dot ${template.status.toLowerCase()}`} />
          <span className="template-row-copy"><strong>{template.name}</strong><span>{previewBody(template)}</span><small>{template.category} · {template.language}</small></span>
          <Badge variant="outline" className={`badge ${template.status.toLowerCase()}`}>{template.status}</Badge>
        </Button>)}{filtered.length === 0 && <div className="list-empty">No templates match these filters.</div>}</div>
      </section>
      {selected ? <section className="template-detail">
        <div className="detail-heading"><div><h2>{selected.name}</h2><p>{wabaName(selected.wabaId)} <span>·</span> {selected.category} <span>·</span> {selected.language}</p></div><Badge variant="outline" className={`badge ${selected.status.toLowerCase()}`}>{selected.status}</Badge></div>
        <div className="preview-stage"><div className="preview-label">WhatsApp preview</div><div className="phone-preview"><div className="preview-contact"><span className="avatar">{wabaName(selected.wabaId).slice(0, 2).toUpperCase()}</span><div><strong>{wabaName(selected.wabaId)}</strong><small>Business account</small></div><span className="preview-menu">•••</span></div><div className="preview-chat"><TemplatePreview template={selected} /></div><div className="preview-compose"><span>Message</span><span>＋</span></div></div><p className="preview-help">Buttons are shown as local previews. URL actions never open an external site, and Flow screens are not simulated.</p></div>
        <div className="template-metadata"><div><span>Template ID</span><code>{selected.metaTemplateId}</code></div><div><span>Generation</span><code>{selected.generation ?? 1}</code></div>{selected.rejectionReason && <div className="rejection-note"><span>Rejection reason</span><strong>{selected.rejectionReason}</strong></div>}</div>
        <div className="template-actions">{selected.status !== 'APPROVED' && <Button onClick={() => void act(api.approve(selected.metaTemplateId, selected.generation ?? 1, selected.status))}>Approve template</Button>}{selected.status !== 'REJECTED' && <Button variant="outline" onClick={() => { const reason = prompt('Rejection reason', 'INVALID_FORMAT'); if (reason !== null) void act(api.reject(selected.metaTemplateId, reason, selected.generation ?? 1, selected.status)) }}>Reject</Button>}{selected.status === 'APPROVED' && <Button variant="outline" onClick={() => void act(api.setTemplateState(selected.metaTemplateId, 'pause', selected.generation ?? 1, selected.status))}>Pause</Button>}{selected.status !== 'DISABLED' && <Button variant="destructive" onClick={() => void act(api.setTemplateState(selected.metaTemplateId, 'disable', selected.generation ?? 1, selected.status))}>Disable</Button>}</div>
      </section> : <section className="template-detail list-empty">Choose a template to preview.</section>}
    </Card>
  </section>
}
