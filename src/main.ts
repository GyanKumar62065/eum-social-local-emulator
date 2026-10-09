import { coverage } from './api/aws.ts'
import { loadConfig } from './config.ts'
import { buildApp } from './server.ts'
import { listPhones, listWabas } from './store/wabas.ts'

const config = loadConfig()
const app = await buildApp({ config })
await app.fastify.listen({ port: config.port, host: config.host })
const base = `http://localhost:${config.port}`
const result = coverage(app.model, app.handlers)
const lines = [
  '', 'EUM Social Local Emulator — AWS End User Messaging Social',
  `  SDK endpoint : ${base}`, `  Inbox        : ${base}/_eum/ui/`,
  `  Operations   : ${result.simulated.length} simulated, ${result.notSimulated.length} routed but not simulated`,
  `  Events       : ${config.aws ? `SNS via ${config.aws.endpoint}` : 'stored only (no aws.endpoint configured)'}`, '',
  ...listWabas(app.ctx.db).flatMap((waba) => [`  WABA ${waba.name}  ${waba.id}`, ...listPhones(app.ctx.db, waba.id).map((phone) => `    ${phone.phoneNumber}  ${phone.id}`)]), '',
]
console.log(lines.join('\n'))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { app.close().then(() => process.exit(0)) })
