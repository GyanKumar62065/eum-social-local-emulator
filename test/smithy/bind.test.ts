import { describe, expect, it } from 'vitest'
import { MODEL_PATH, SmithyModel } from '../../src/smithy/model.ts'
import { bindInput, toJson } from '../../src/smithy/bind.ts'

const model = SmithyModel.load(MODEL_PATH)
const op = (name: string) => model.operations.get(name)!

describe('bindInput', () => {
  it('maps query parameters by their httpQuery name, not the member name', () => {
    const q = new URLSearchParams('id=waba-1&templateName=t&deleteAllTemplates=true')
    expect(bindInput(model, op('DeleteWhatsAppMessageTemplate'), q, {})).toEqual({ id: 'waba-1', templateName: 't', deleteAllLanguages: true })
  })

  it('coerces numeric query values and leaves bad ones for the validator', () => {
    expect(bindInput(model, op('ListLinkedWhatsAppBusinessAccounts'), new URLSearchParams('maxResults=5'), {})).toEqual({ maxResults: 5 })
    expect(bindInput(model, op('ListLinkedWhatsAppBusinessAccounts'), new URLSearchParams('maxResults=abc'), {})).toEqual({ maxResults: 'abc' })
  })

  it('decodes base64 blobs from the JSON body and ignores unknown keys', () => {
    const input = bindInput(model, op('SendWhatsAppMessage'), new URLSearchParams(), {
      originationPhoneNumberId: 'phone-number-id-1', message: Buffer.from('{"a":1}').toString('base64'), metaApiVersion: 'v20.0', junk: 1,
    })
    expect(Buffer.isBuffer(input.message)).toBe(true)
    expect((input.message as Buffer).toString('utf8')).toBe('{"a":1}')
    expect(input).not.toHaveProperty('junk')
  })

  it('binds nested structures and lists', () => {
    const input = bindInput(model, op('PutWhatsAppBusinessAccountEventDestinations'), new URLSearchParams(), {
      id: 'waba-1', eventDestinations: [{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }],
    })
    expect(input.eventDestinations).toEqual([{ eventDestinationArn: 'arn:aws:sns:ap-south-1:000000000000:t' }])
  })
})

describe('toJson', () => {
  it('serializes timestamps as epoch seconds and drops undeclared members', () => {
    const out = toJson(model, op('ListLinkedWhatsAppBusinessAccounts').output, {
      linkedAccounts: [{ id: 'waba-1', linkDate: new Date(1_759_800_000_000), extra: 'x' }], ignored: true,
    })
    expect(out).toEqual({ linkedAccounts: [{ id: 'waba-1', linkDate: 1_759_800_000 }] })
  })

  it('serializes blobs as base64', () => {
    const shape = 'com.amazonaws.socialmessaging#SendWhatsAppMessageInput'
    expect(toJson(model, shape, { message: Buffer.from('hi') })).toEqual({ message: 'aGk=' })
  })
})
