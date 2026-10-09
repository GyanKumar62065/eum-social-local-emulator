import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel, shortName } from '../../src/smithy/model.ts'

describe('SmithyModel', () => {
  const model = SmithyModel.load(MODEL_PATH)

  it('loads every operation of the vendored model', () => {
    expect(model.operations.size).toBe(38)
    expect(model.namespace).toBe('com.amazonaws.socialmessaging')
  })

  it('reads http bindings and merges service-level errors', () => {
    const op = model.operations.get('SendWhatsAppMessage')!
    expect(op).toMatchObject({ method: 'POST', uri: '/v1/whatsapp/send' })
    expect(op.input).toBe('com.amazonaws.socialmessaging#SendWhatsAppMessageInput')
    expect(op.errors).toEqual(expect.arrayContaining(['ResourceNotFoundException', 'AccessDeniedException', 'ValidationException']))
  })

  it('resolves prelude shapes and error status codes', () => {
    expect(model.shape('smithy.api#String').type).toBe('string')
    expect(model.shape('smithy.api#Unit').type).toBe('structure')
    expect(model.errorStatus('ThrottledRequestException')).toBe(429)
    expect(model.errorStatus('ResourceNotFoundException')).toBe(404)
    expect(model.errorStatus('DependencyException')).toBe(502)
    expect(() => model.shape('nope#Nope')).toThrow(/unknown shape/)
  })

  it('shortName strips the namespace', () => {
    expect(shortName('com.amazonaws.socialmessaging#Foo')).toBe('Foo')
  })
})
