import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ctx, HandlerMap } from '../context.ts'
import { bindInput, toJson } from '../smithy/bind.ts'
import { AwsError } from '../smithy/errors.ts'
import type { SmithyModel } from '../smithy/model.ts'
import { buildRouter } from '../smithy/router.ts'
import { validate, validationMessage } from '../smithy/validate.ts'

const sendError = (reply: FastifyReply, status: number, type: string, message: string) => reply.code(status).header('x-amzn-errortype', type).type('application/json').send(JSON.stringify({ message }))
export function coverage(model: SmithyModel, handlers: HandlerMap): { simulated: string[]; notSimulated: string[] } {
  const operations = [...model.operations.keys()].sort()
  return { simulated: operations.filter((name) => handlers[name]), notSimulated: operations.filter((name) => !handlers[name]) }
}
export function registerAwsApi(app: FastifyInstance, model: SmithyModel, handlers: HandlerMap, ctx: Ctx): void {
  const router = buildRouter(model)
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    scope.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], url: '/v1/*',
      handler: async (request, reply) => {
        reply.header('x-amzn-requestid', randomUUID())
        const url = new URL(request.url, 'http://local')
        const operation = router.match(request.method, url.pathname)
        if (!operation) return sendError(reply, 404, 'UnknownOperationException', `eum-social-local-emulator: no operation for ${request.method} ${url.pathname}`)
        if (!String(request.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256')) return sendError(reply, 403, 'AccessDeniedException', 'Missing Authentication Token: requests must be signed with AWS SigV4')
        let body: unknown = {}
        const raw = request.body as Buffer | undefined
        if (raw && raw.length > 0) {
          try { body = JSON.parse(raw.toString('utf8')) }
          catch { return sendError(reply, 400, 'ValidationException', 'Request body is not valid JSON') }
        }
        const input = bindInput(model, operation, url.searchParams, body)
        const violations = validate(model, operation.input, input)
        if (violations.length) return sendError(reply, 400, 'ValidationException', validationMessage(violations))
        const handler = handlers[operation.name]
        if (!handler) return sendError(reply, 501, 'InternalServiceException', `eum-social-local-emulator: ${operation.name} is not simulated yet`)
        try {
          const output = await handler(input, ctx)
          return reply.code(200).type('application/json').send(JSON.stringify(toJson(model, operation.output, output) ?? {}))
        } catch (error) {
          if (error instanceof AwsError && operation.errors.includes(error.type)) return sendError(reply, error.status ?? model.errorStatus(error.type), error.type, error.message)
          request.log.error({ err: error, operation: operation.name }, 'eum-social-local-emulator: handler failed')
          const message = error instanceof AwsError ? `eum-social-local-emulator bug: ${operation.name} raised undeclared ${error.type}: ${error.message}` : 'eum-social-local-emulator internal error; see the server log'
          return sendError(reply, 500, 'InternalServiceException', message)
        }
      },
    })
  })
}
