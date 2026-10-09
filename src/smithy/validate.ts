import type { MemberRef, SmithyModel, Traits } from './model.ts'

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function validate(model: SmithyModel, shapeId: string, value: unknown): string[] {
  const errors: string[] = []
  const shape = model.shape(shapeId)
  const obj = isObj(value) ? value : {}
  for (const [name, ref] of Object.entries(shape.members ?? {})) checkMember(model, ref, obj[name], name, errors)
  return errors
}

export function validationMessage(violations: string[]): string {
  const count = violations.length
  return `${count} validation error${count === 1 ? '' : 's'} detected: ${violations.join('; ')}`
}

function checkMember(model: SmithyModel, ref: MemberRef, value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) {
    if (ref.traits?.['smithy.api#required'] !== undefined) errors.push(`Value null at '${path}' failed to satisfy constraint: Member must not be null`)
    return
  }
  checkValue(model, ref.target, { ...model.shape(ref.target).traits, ...ref.traits }, value, path, errors)
}

function checkValue(model: SmithyModel, target: string, traits: Traits, value: unknown, path: string, errors: string[]): void {
  const shape = model.shape(target)
  const fail = (reason: string) => errors.push(`Value at '${path}' failed to satisfy constraint: ${reason}`)
  const sensitive = traits['smithy.api#sensitive'] !== undefined
  const shown = (item: unknown) => sensitive ? '' : ` '${String(item).slice(0, 200)}'`
  const checkLength = (length: number) => {
    const constraint = traits['smithy.api#length']
    if (!constraint) return
    if (constraint.min !== undefined && length < constraint.min) errors.push(`Value${shown(value)} at '${path}' failed to satisfy constraint: Member must have length greater than or equal to ${constraint.min}`)
    if (constraint.max !== undefined && length > constraint.max) errors.push(`Value${shown(value)} at '${path}' failed to satisfy constraint: Member must have length less than or equal to ${constraint.max}`)
  }
  const checkRange = (number: number) => {
    const constraint = traits['smithy.api#range']
    if (!constraint) return
    if (constraint.min !== undefined && number < constraint.min) errors.push(`Value '${number}' at '${path}' failed to satisfy constraint: Member must have value greater than or equal to ${constraint.min}`)
    if (constraint.max !== undefined && number > constraint.max) errors.push(`Value '${number}' at '${path}' failed to satisfy constraint: Member must have value less than or equal to ${constraint.max}`)
  }

  switch (shape.type) {
    case 'string':
    case 'enum': {
      if (typeof value !== 'string') return void fail('Member must be a string')
      if (shape.type === 'enum') {
        const allowed = Object.values(shape.members ?? {}).map((member) => member.traits?.['smithy.api#enumValue'])
        if (!allowed.includes(value)) errors.push(`Value${shown(value)} at '${path}' failed to satisfy constraint: Member must satisfy enum value set: [${allowed.join(', ')}]`)
      }
      checkLength([...value].length)
      const pattern = traits['smithy.api#pattern']
      if (pattern && !new RegExp(pattern).test(value)) errors.push(`Value${shown(value)} at '${path}' failed to satisfy constraint: Member must satisfy regular expression pattern: ${pattern}`)
      return
    }
    case 'blob':
      if (!(value instanceof Uint8Array)) return void fail('Member must be a blob')
      return checkLength(value.byteLength)
    case 'boolean':
      if (typeof value !== 'boolean') fail('Member must be a boolean')
      return
    case 'integer':
    case 'long':
      if (typeof value !== 'number' || !Number.isInteger(value)) return void fail('Member must be an integer')
      return checkRange(value)
    case 'float':
    case 'double':
      if (typeof value !== 'number' || Number.isNaN(value)) return void fail('Member must be a number')
      return checkRange(value)
    case 'timestamp':
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('Member must be a timestamp')
      return
    case 'list': {
      if (!Array.isArray(value)) return void fail('Member must be a list')
      checkLength(value.length)
      const member = shape.member!
      value.forEach((item, index) => {
        if (item !== null && item !== undefined) checkValue(model, member.target, { ...model.shape(member.target).traits, ...member.traits }, item, `${path}.${index}`, errors)
      })
      return
    }
    case 'map': {
      if (!isObj(value)) return void fail('Member must be a map')
      checkLength(Object.keys(value).length)
      const key = shape.key!
      const val = shape.value!
      for (const [name, item] of Object.entries(value)) {
        checkValue(model, key.target, { ...model.shape(key.target).traits, ...key.traits }, name, `${path}.${name}`, errors)
        if (item !== null && item !== undefined) checkValue(model, val.target, { ...model.shape(val.target).traits, ...val.traits }, item, `${path}.${name}`, errors)
      }
      return
    }
    case 'structure': {
      if (!isObj(value)) return void fail('Member must be a structure')
      for (const [name, ref] of Object.entries(shape.members ?? {})) checkMember(model, ref, value[name], `${path}.${name}`, errors)
      return
    }
    default: return
  }
}
