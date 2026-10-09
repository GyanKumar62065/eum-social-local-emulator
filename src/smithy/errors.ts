// Handler errors are serialized only when their type is declared by the Smithy operation.
export class AwsError extends Error {
  readonly type: string
  readonly status?: number

  constructor(type: string, message: string, status?: number) {
    super(message)
    this.type = type
    this.status = status
  }
}

export const notFound = (what: string): AwsError => new AwsError('ResourceNotFoundException', `${what} not found`)
export const invalid = (message: string): AwsError => new AwsError('InvalidParametersException', message)
