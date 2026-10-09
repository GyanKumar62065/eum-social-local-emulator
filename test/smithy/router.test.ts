import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { buildRouter } from '../../src/smithy/router.ts'

describe('router', () => {
  const model = SmithyModel.load(MODEL_PATH)
  const router = buildRouter(model)

  it('routes every operation to a unique method + path', () => {
    expect(router.routes()).toHaveLength(model.operations.size)
    for (const op of model.operations.values()) expect(router.match(op.method, op.uri)?.name).toBe(op.name)
  })

  it('distinguishes operations sharing a path by method', () => {
    expect(router.match('GET', '/v1/whatsapp/template')?.name).toBe('GetWhatsAppMessageTemplate')
    expect(router.match('POST', '/v1/whatsapp/template')?.name).toBe('UpdateWhatsAppMessageTemplate')
    expect(router.match('DELETE', '/v1/whatsapp/template')?.name).toBe('DeleteWhatsAppMessageTemplate')
  })

  it('tolerates a trailing slash and lowercase method, rejects unknown paths', () => {
    expect(router.match('post', '/v1/whatsapp/send/')?.name).toBe('SendWhatsAppMessage')
    expect(router.match('GET', '/v1/whatsapp/nope')).toBeUndefined()
  })
})
