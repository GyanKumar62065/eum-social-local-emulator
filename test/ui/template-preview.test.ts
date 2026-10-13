import { describe, expect, it } from 'vitest'
import { resolveButtonDestination } from '../../ui/src/TemplatePreview.tsx'

describe('WhatsApp URL button preview', () => {
  it('resolves the parameter by button index without navigating', () => {
    const template = { type: 'template', body: { template: { components: [
      { type: 'button', index: '0', parameters: [{ type: 'text', text: 'INV-1042' }] },
      { type: 'button', index: '1', parameters: [{ type: 'text', text: 'files-7' }] },
    ] } } } as any
    expect(resolveButtonDestination({ type: 'URL', url: 'https://local.invalid/invoices/{{1}}' }, 0, template)).toBe('https://local.invalid/invoices/INV-1042')
    expect(resolveButtonDestination({ type: 'URL', url: 'https://local.invalid/files/{{1}}' }, 1, template)).toBe('https://local.invalid/files/files-7')
  })
})
