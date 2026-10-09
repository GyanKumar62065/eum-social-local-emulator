import type { TemplateComponent } from '../../store/types.ts'
export interface LibraryEntry { templateName: string; templateLanguage: string; templateCategory: string; templateTopic: string; templateUseCase: string; templateIndustry: string[]; templateHeader?: string; templateBody: string; templateBodyExampleParams: string[]; templateButtons?: { type: string; text: string; url?: string }[]; templateId: string }
export const LIBRARY: LibraryEntry[] = [
  { templateName: 'payment_reminder_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'PAYMENT_REMINDER', templateIndustry: ['E_COMMERCE', 'FINANCIAL_SERVICES'], templateHeader: 'Payment reminder', templateBody: 'Hi {{1}}, this is a reminder that your payment of {{2}} for invoice {{3}} is due on {{4}}.', templateBodyExampleParams: ['Asha', '₹12,000', 'INV-1042', '9 Oct'], templateId: '100000000000101' },
  { templateName: 'payment_received_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'RECEIPT', templateIndustry: ['E_COMMERCE', 'FINANCIAL_SERVICES'], templateBody: 'Hi {{1}}, we have received your payment of {{2}} for invoice {{3}}. Thank you!', templateBodyExampleParams: ['Asha', '₹12,000', 'INV-1042'], templateId: '100000000000102' },
  { templateName: 'payment_overdue_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'PAYMENTS', templateUseCase: 'PAYMENT_OVERDUE', templateIndustry: ['FINANCIAL_SERVICES'], templateBody: 'Hi {{1}}, invoice {{2}} for {{3}} is now {{4}} days overdue. Please pay at your earliest convenience.', templateBodyExampleParams: ['Asha', 'INV-1042', '₹12,000', '7'], templateButtons: [{ type: 'URL', text: 'Pay now', url: 'https://example.com/pay/{{1}}' }], templateId: '100000000000103' },
  { templateName: 'invoice_available_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'INVOICES', templateUseCase: 'INVOICE', templateIndustry: ['E_COMMERCE'], templateBody: 'Hi {{1}}, your invoice {{2}} for {{3}} is ready.', templateBodyExampleParams: ['Asha', 'INV-1042', '₹12,000'], templateId: '100000000000104' },
  { templateName: 'account_update_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'ACCOUNT', templateUseCase: 'ACCOUNT_UPDATE', templateIndustry: ['FINANCIAL_SERVICES'], templateBody: 'Hi {{1}}, your account details were updated on {{2}}. If this was not you, contact us.', templateBodyExampleParams: ['Asha', '7 Oct'], templateId: '100000000000105' },
  { templateName: 'statement_ready_1', templateLanguage: 'en_US', templateCategory: 'UTILITY', templateTopic: 'ACCOUNT', templateUseCase: 'STATEMENT', templateIndustry: ['FINANCIAL_SERVICES'], templateBody: 'Hi {{1}}, your statement for {{2}} is ready to view.', templateBodyExampleParams: ['Asha', 'September'], templateId: '100000000000106' },
]
export function libraryComponents(entry: LibraryEntry): TemplateComponent[] {
  const components: TemplateComponent[] = []
  if (entry.templateHeader) components.push({ type: 'HEADER', format: 'TEXT', text: entry.templateHeader })
  components.push({ type: 'BODY', text: entry.templateBody, example: { body_text: [entry.templateBodyExampleParams] } })
  if (entry.templateButtons) components.push({ type: 'BUTTONS', buttons: entry.templateButtons })
  return components
}
