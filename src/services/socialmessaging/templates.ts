import { createHash, randomBytes } from 'node:crypto'
import type { Ctx, HandlerMap } from '../../context.ts'
import { metaNumericId } from '../../domain/ids.ts'
import { paginate } from '../../domain/paging.ts'
import { validateTemplateName } from '../../domain/templates.ts'
import { invalid, notFound } from '../../smithy/errors.ts'
import { insertMedia } from '../../store/media.ts'
import { deleteTemplate, findTemplate, getTemplateById, insertTemplate, listTemplates, listTemplatesByName, updateTemplate } from '../../store/templates.ts'
import type { TemplateComponent, TemplateRow, WabaRow } from '../../store/types.ts'
import { LIBRARY, libraryComponents } from './library.ts'
import { readS3 } from './s3io.ts'
import { requireWaba } from './waba.ts'

function parseBlobJson(blob: Uint8Array, what: string): any {
  try { return JSON.parse(Buffer.from(blob).toString('utf8')) }
  catch { throw invalid(`${what} is not valid JSON`) }
}
const metaTemplate = (template: TemplateRow) => ({ ...template.definition, name: template.name, language: template.language, category: template.definition?.category ?? template.category, status: template.status, id: template.metaTemplateId, parameter_format: template.definition?.parameter_format ?? template.definition?.parameterFormat ?? template.parameterFormat, components: template.components })
function newTemplate(ctx: Ctx, waba: WabaRow, definition: Record<string, any>): TemplateRow {
  const nameError = validateTemplateName(definition.name)
  if (nameError) throw invalid(nameError)
  if (typeof definition.language !== 'string' || !definition.language) throw invalid('language is required')
  if (typeof definition.category !== 'string' || !definition.category) throw invalid('category is required')
  if (!Array.isArray(definition.components)) throw invalid('components must be an array')
  const name = definition.name as string
  if (findTemplate(ctx.db, waba.id, name, definition.language)) throw invalid(`Template ${name} (${definition.language}) already exists`)
  const now = ctx.clock.now()
  const template: TemplateRow = {
    metaTemplateId: metaNumericId(), wabaId: waba.id, name, language: definition.language,
    category: definition.category.toUpperCase(), status: 'PENDING', parameterFormat: String(definition.parameter_format ?? definition.parameterFormat ?? 'POSITIONAL').toUpperCase(),
    components: definition.components as TemplateComponent[], definition: { ...definition }, generation: 1, createdAt: now, updatedAt: now,
  }
  insertTemplate(ctx.db, template); ctx.sim.scheduleTemplateApproval(template); ctx.bus.notify({ type: 'template', template }); return template
}
function findOne(ctx: Ctx, waba: WabaRow, input: { metaTemplateId?: string; templateName?: string; templateLanguageCode?: string }): TemplateRow {
  let template: TemplateRow | undefined
  if (input.metaTemplateId) template = getTemplateById(ctx.db, input.metaTemplateId)
  else if (input.templateName && input.templateLanguageCode) template = findTemplate(ctx.db, waba.id, input.templateName, input.templateLanguageCode)
  else throw invalid('Provide metaTemplateId, or templateName and templateLanguageCode')
  if (!template || template.wabaId !== waba.id) throw notFound('Template')
  return template
}
const created = (template: TemplateRow) => ({ metaTemplateId: template.metaTemplateId, templateStatus: template.status, category: template.category })

export const templateHandlers: HandlerMap = {
  CreateWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id); const definition = parseBlobJson(input.templateDefinition, 'templateDefinition')
    return created(newTemplate(ctx, waba, definition))
  },
  CreateWhatsAppMessageTemplateFromLibrary(input, ctx) {
    const waba = requireWaba(ctx, input.id); const requested = input.metaLibraryTemplate
    const entry = LIBRARY.find((item) => item.templateName === requested.libraryTemplateName)
    if (!entry) throw invalid(`Library template ${requested.libraryTemplateName} not found`)
    return created(newTemplate(ctx, waba, { name: requested.templateName, language: requested.templateLanguage, category: requested.templateCategory, components: libraryComponents(entry) }))
  },
  GetWhatsAppMessageTemplate(input, ctx) { const waba = requireWaba(ctx, input.id); return { template: JSON.stringify(metaTemplate(findOne(ctx, waba, input))) } },
  ListWhatsAppMessageTemplates(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    const page = paginate(listTemplates(ctx.db, waba.id).map((template) => ({ templateName: template.name, metaTemplateId: template.metaTemplateId, templateStatus: template.status, templateQualityScore: 'UNKNOWN', templateLanguage: template.language, templateCategory: template.category })), input.nextToken, input.maxResults)
    return { templates: page.items, nextToken: page.nextToken }
  },
  UpdateWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id); const template = findOne(ctx, waba, input)
    const components = input.templateComponents ? parseBlobJson(input.templateComponents, 'templateComponents') : template.components
    if (!Array.isArray(components)) throw invalid('templateComponents must be a JSON array')
    const category = input.templateCategory?.toUpperCase() ?? template.category
    const parameterFormat = input.parameterFormat?.toUpperCase() ?? template.parameterFormat
    const definition = { ...(template.definition ?? {}), ...(input.templateCategory ? { category: input.templateCategory } : {}), ...(input.parameterFormat ? { parameter_format: input.parameterFormat } : {}), ...(input.templateComponents ? { components } : {}) }
    const updated: TemplateRow = { ...template, category, parameterFormat, components, definition, generation: (template.generation ?? 1) + 1, status: 'PENDING', rejectionReason: undefined, updatedAt: ctx.clock.now() }
    updateTemplate(ctx.db, updated); ctx.sim.scheduleTemplateApproval(updated); ctx.bus.notify({ type: 'template', template: updated }); return {}
  },
  DeleteWhatsAppMessageTemplate(input, ctx) {
    const waba = requireWaba(ctx, input.id); const byName = listTemplatesByName(ctx.db, waba.id, input.templateName)
    const matches = input.metaTemplateId && !input.deleteAllLanguages ? byName.filter((template) => template.metaTemplateId === input.metaTemplateId) : byName
    if (matches.length === 0) throw notFound(`Template ${input.templateName}`)
    for (const template of matches) deleteTemplate(ctx.db, template.metaTemplateId)
    ctx.bus.notify({ type: 'waba' }); return {}
  },
  ListWhatsAppTemplateLibrary(input, ctx) {
    requireWaba(ctx, input.id); const filters: Record<string, string> = input.filters ?? {}
    const items = LIBRARY.filter((entry) => (!filters.searchKey || `${entry.templateName} ${entry.templateBody}`.toLowerCase().includes(filters.searchKey.toLowerCase())) && (!filters.topic || entry.templateTopic === filters.topic) && (!filters.usecase || entry.templateUseCase === filters.usecase) && (!filters.industry || entry.templateIndustry.includes(filters.industry)) && (!filters.language || entry.templateLanguage === filters.language))
    const page = paginate(items, input.nextToken, input.maxResults); return { metaLibraryTemplates: page.items, nextToken: page.nextToken }
  },
  async CreateWhatsAppMessageTemplateMedia(input, ctx) {
    const waba = requireWaba(ctx, input.id)
    if (!input.sourceS3File) throw invalid('sourceS3File is required')
    const { bytes, mimeType } = await readS3(ctx, input.sourceS3File)
    const handle = `4::${Buffer.from(mimeType).toString('base64')}:${randomBytes(24).toString('base64url')}`
    insertMedia(ctx.db, { mediaId: handle, ownerId: waba.id, mimeType, sha256: createHash('sha256').update(bytes).digest('base64'), bytes, createdAt: ctx.clock.now() })
    return { metaHeaderHandle: handle }
  },
}
