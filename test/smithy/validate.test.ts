import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { validate, validationMessage } from '../../src/smithy/validate.ts'

const model = SmithyModel.load(MODEL_PATH)
const input = (op: string) => model.operations.get(op)!.input

describe('validate', () => {
  it('accepts a valid SendWhatsAppMessage input', () => {
    expect(validate(model, input('SendWhatsAppMessage'), { originationPhoneNumberId: 'phone-number-id-abc', message: Buffer.from('{}'), metaApiVersion: 'v20.0' })).toEqual([])
  })

  it('reports missing required members with the AWS wording', () => {
    expect(validate(model, input('SendWhatsAppMessage'), { message: Buffer.from('{}'), metaApiVersion: 'v20.0' })).toEqual([
      "Value null at 'originationPhoneNumberId' failed to satisfy constraint: Member must not be null",
    ])
  })

  it('checks pattern, length and range', () => {
    expect(validate(model, input('ListLinkedWhatsAppBusinessAccounts'), { maxResults: 500 })[0]).toMatch(/at 'maxResults'.*less than or equal to 100/)
    expect(validate(model, input('GetLinkedWhatsAppBusinessAccount'), { id: 'not-a-waba' })[0]).toMatch(/at 'id'.*regular expression pattern/)
    expect(validate(model, input('SendWhatsAppMessage'), { originationPhoneNumberId: 'phone-number-id-abc', message: Buffer.alloc(0), metaApiVersion: 'v20.0' })[0]).toMatch(/at 'message'.*length greater than or equal to 1/)
  })

  it('reports wrong JSON types instead of crashing', () => {
    expect(validate(model, input('ListLinkedWhatsAppBusinessAccounts'), { maxResults: 'abc' })[0]).toMatch(/at 'maxResults'.*must be an integer/)
    expect(validate(model, input('PutWhatsAppBusinessAccountEventDestinations'), { id: 'waba-1', eventDestinations: 'x' })[0]).toMatch(/at 'eventDestinations'.*must be a list/)
  })

  it('validates nested list members with indexed paths', () => {
    expect(validate(model, input('PutWhatsAppBusinessAccountEventDestinations'), { id: 'waba-1', eventDestinations: [{}] })).toEqual([
      "Value null at 'eventDestinations.0.eventDestinationArn' failed to satisfy constraint: Member must not be null",
    ])
  })

  it('validates map keys and values', () => {
    const long = 'x'.repeat(101)
    expect(validate(model, input('ListWhatsAppTemplateLibrary'), { id: 'waba-1', filters: { [long]: 'v' } })[0]).toMatch(/filters/)
  })

  it('formats the summary message', () => {
    expect(validationMessage(['a', 'b'])).toBe('2 validation errors detected: a; b')
    expect(validationMessage(['a'])).toBe('1 validation error detected: a')
  })
})
