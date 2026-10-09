import { describe, expect, it } from 'vitest'
import { renderOutbound } from '../../src/domain/render.ts'
import { checkTemplateSend, placeholders, renderTemplate, suppliedParams, validateTemplateName } from '../../src/domain/templates.ts'
import type { TemplateRow } from '../../src/store/types.ts'
const tpl = (over: Partial<TemplateRow> = {}): TemplateRow => ({ metaTemplateId: '1', wabaId: 'w', name: 'invoice_reminder', language: 'en', category: 'UTILITY', status: 'APPROVED', parameterFormat: 'POSITIONAL', components: [{ type: 'HEADER', format: 'TEXT', text: 'Reminder' }, { type: 'BODY', text: 'Hi {{1}}, invoice {{2}} is due {{3}}. Thanks {{1}}' }], createdAt: 0, updatedAt: 0, ...over })
const send = (params: unknown[]) => ({ name: 'invoice_reminder', language: { code: 'en' }, components: [{ type: 'body', parameters: params }] })
describe('templates', () => {
  it('counts distinct placeholders', () => { expect(placeholders('Hi {{1}}, {{2}} and {{ 1 }} {{name}}')).toEqual(['1', '2', 'name']) })
  it('extracts body parameters of every Meta parameter type', () => {
    expect(suppliedParams(send([{ type: 'text', text: 'Asha' }, { type: 'currency', currency: { fallback_value: '₹1,200', code: 'INR', amount_1000: 1200000 } }, { type: 'date_time', date_time: { fallback_value: 'Oct 9' } }, { type: 'text', text: 'Ravi', parameter_name: 'agent' }]))).toEqual({ positional: ['Asha', '₹1,200', 'Oct 9'], named: { agent: 'Ravi' } })
    expect(suppliedParams(undefined)).toEqual({ positional: [], named: {} })
  })
  it('renders positional and named templates', () => {
    expect(renderTemplate(tpl(), send([{ type: 'text', text: 'Asha' }, { type: 'text', text: 'INV-1' }, { type: 'text', text: 'Friday' }]))).toBe('Hi Asha, invoice INV-1 is due Friday. Thanks Asha')
    const named = tpl({ parameterFormat: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{first_name}}' }] })
    expect(renderTemplate(named, send([{ type: 'text', text: 'Asha', parameter_name: 'first_name' }]))).toBe('Hi Asha')
  })
  it('applies Meta asynchronous template checks', () => {
    expect(checkTemplateSend(undefined, { template: send([]) })).toMatchObject({ code: 132001 })
    expect(checkTemplateSend(tpl({ status: 'PENDING' }), { template: send([]) })).toMatchObject({ code: 132001 })
    expect(checkTemplateSend(tpl(), { template: send([{ type: 'text', text: 'a' }]) })).toMatchObject({ code: 132000 })
    expect(checkTemplateSend(tpl(), { template: send([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }]) })).toBeNull()
  })
  it('validates template names', () => { expect(validateTemplateName('invoice_reminder_2')).toBeNull(); expect(validateTemplateName('Invoice Reminder')).toMatch(/lowercase/); expect(validateTemplateName('')).toMatch(/lowercase/) })
  it('renders outbound bodies for the inbox', () => {
    expect(renderOutbound({ type: 'text', text: { body: 'hello' } }, undefined)).toBe('hello')
    expect(renderOutbound({ type: 'image', image: { link: 'x', caption: 'Invoice' } }, undefined)).toBe('[image] Invoice')
    expect(renderOutbound({ type: 'reaction', reaction: { emoji: '👍' } }, undefined)).toBe('reacted 👍')
    expect(renderOutbound({ type: 'template', template: { name: 'nope', language: { code: 'en' } } }, undefined)).toBe('[template nope/en not found]')
    expect(renderOutbound({ type: 'location' }, undefined)).toBe('[location]')
  })
})
