# EUM Social Local Emulator

A local development emulator for **AWS End User Messaging Social** (WhatsApp). Run it on your
workstation or in a development container, then point an AWS SDK client at its endpoint to develop
and exercise application integrations without sending messages through AWS or Meta.

The emulator implements a documented subset of the AWS `socialmessaging` API using the service
model included in this package. It provides seeded WhatsApp Business Accounts (WABAs), phone
numbers and templates; a browser inbox; configurable message status flows and failure rules; and
locally persisted messages and events. Event delivery can be connected to SNS-compatible services
such as LocalStack.

> This is a development tool. It does not connect to AWS End User Messaging or Meta, deliver real
> WhatsApp messages, verify provider credentials, or reproduce every AWS operation. Unsupported
> modeled operations return a modeled `501` response. Do not use it as a production message
> transport or with production credentials/data.

## Who this is for

Use the emulator when an application uses the AWS SDK for End User Messaging Social and needs a
repeatable local endpoint for development, demos, and integration checks. Keep your application's
AWS SDK integration; configure its endpoint override to the emulator. The emulator is a separate
local service, not an in-process replacement AWS SDK or a client-side library.

## Requirements

- Node.js 24 or newer to run the server (uses Node's built-in SQLite support)
- Bun 1.3.12 or newer to install dependencies and run project scripts
- Docker Compose only when using the optional LocalStack example

## Quick start from this repository

```sh
bun install --frozen-lockfile
bun run ui:build
cp eum-social-local-emulator.example.yaml eum-social-local-emulator.yaml
EUM_CONFIG=./eum-social-local-emulator.yaml bun run start
```

The server listens on `http://localhost:4580`. Open the inbox at
[http://localhost:4580](http://localhost:4580). On startup, the terminal prints seeded AWS resource
IDs; use those IDs in your application calls. The default region is `ap-south-1`; local credentials
such as `test` / `test` are accepted because the emulator does not authenticate AWS requests.

The database defaults to `./data/eum-local.db` and is created automatically. The example config
contains a WABA, phone number, and approved template. Copy it to `eum-social-local-emulator.yaml` before editing;
that local file is intentionally not part of the published package.

## Install the public package

The package is configured for public npm publication under the `@gyankumar62065` scope. Once
published, anyone can install it from the registry; a paid npm account is not required for public
packages. This project uses Bun for installation and development scripts.

```sh
bun add @gyankumar62065/eum-social-local-emulator
```

Install it as a development dependency in your application or a dedicated tools package. Start the
emulator from a directory containing `eum-social-local-emulator.yaml`:

```sh
bun add --dev @gyankumar62065/eum-social-local-emulator
cp node_modules/@gyankumar62065/eum-social-local-emulator/eum-social-local-emulator.example.yaml ./eum-social-local-emulator.yaml
EUM_CONFIG=./eum-social-local-emulator.yaml bunx eum-social-local-emulator
```

The server reads configuration from the current working directory by default, so set `EUM_CONFIG`
when the config is elsewhere.

## Connect an application

Configure the AWS SDK client in your application to use the emulator URL. Keep this endpoint
override in local or test configuration; do not use it in production.

### JavaScript / TypeScript (AWS SDK v3)

```ts
import { SocialMessagingClient } from '@aws-sdk/client-socialmessaging'

const socialMessaging = new SocialMessagingClient({
  region: 'ap-south-1',
  endpoint: process.env.EUM_ENDPOINT ?? 'http://localhost:4580',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
})
```

Use the generated resource IDs printed at emulator startup with the SDK commands your workflow
needs. The emulator supports a subset of the modeled operations; check the API support notes below
before depending on a particular operation.

### Java (AWS SDK v2)

A small [Java smoke-test project](https://github.com/GyanKumar62065/eum-social-local-emulator/tree/main/test/java)
is included in the source repository under `test/java`:

```sh
cd test/java
mvn compile exec:java -Dexec.args="http://localhost:4580 PHONE_NUMBER_ID"
```

It exercises phone-number lookup, template sending, and modeled error handling. Replace
`PHONE_NUMBER_ID` with the value printed by the running emulator.

## Configuration

The emulator reads `eum-social-local-emulator.yaml` from the current working directory. Set `EUM_CONFIG` to select
another file. If no file exists, it starts with defaults and no seeded WABAs.

| YAML key | Default | Purpose |
| --- | --- | --- |
| `port` | `4580` | HTTP port |
| `host` | `127.0.0.1` | Bind address; loopback keeps the local admin API off the network by default |
| `dbPath` | `./data/eum-local.db` | SQLite database path |
| `region` | `ap-south-1` | Region used in generated ARNs and SDK integration |
| `accountId` | `000000000000` | Account ID used in generated ARNs |
| `aws.endpoint` | unset | Optional AWS-compatible endpoint for SNS events and S3 media; unset disables those integrations |
| `webhookUrl` | unset | Optional webhook event destination |
| `wabas` | `[]` | WABA seeds, including `name`, numeric `metaWabaId`, `eventDestinations`, `phoneNumbers` and `templates` |
| `templates.autoApproveSeconds` | `0` | `0` approves immediately; `-1` leaves templates for manual review in the inbox |
| `sim.defaultFlow` | `[sent, delivered, read]` | Default status progression for simulated messages |
| `sim.stepDelayMs` | `1000` | Delay between status events |

The default bind address is loopback, so the emulator and its administration API are available only
from the local machine. To connect from another development container, set `EUM_HOST=0.0.0.0` or
configure `host` explicitly; this exposes the unauthenticated local administration API to that
network, so use it only on a trusted development network.
| `sim.rules` | `[]` | Ordered recipient/type/template rules for delivery status flows or immediate modeled request errors (`denied`, `throttled`, `dependency`, `internal`) |
| `messageIdMode` | `uuid` | `uuid` or WhatsApp-style `wamid` message identifiers |

Environment variables override corresponding YAML settings:

| Variable | Purpose |
| --- | --- |
| `EUM_CONFIG` | Configuration file path |
| `EUM_PORT` | HTTP port |
| `EUM_HOST` | Bind address |
| `EUM_DB` | SQLite database path |
| `EUM_REGION` | AWS region |
| `EUM_AWS_ENDPOINT` | AWS-compatible endpoint for SNS and S3 integrations |

The `metaWabaId` and `metaPhoneNumberId` values in seeds must be numeric strings. Seed phone
numbers use E.164 format. See [`eum-social-local-emulator.example.yaml`](eum-social-local-emulator.example.yaml) for a complete
configuration example and inline rule examples.

## Supported AWS operations

The current implementation simulates these AWS End User Messaging Social operations:

- `ListLinkedWhatsAppBusinessAccounts`
- `GetLinkedWhatsAppBusinessAccount`
- `GetLinkedWhatsAppBusinessAccountPhoneNumber`
- `PutWhatsAppBusinessAccountEventDestinations`
- `CreateWhatsAppMessageTemplate`
- `UpdateWhatsAppMessageTemplate`
- `GetWhatsAppMessageTemplate`
- `ListWhatsAppMessageTemplates`
- `SendWhatsAppMessage`

Other operations present in the vendored service model return a modeled `501` response. The
emulator does not claim complete AWS service coverage. Synchronous invalid requests return modeled
errors; simulation rules can also return immediate denied/throttled/dependency/internal failures.
An unknown or inactive template is rejected synchronously. A structurally valid send whose Meta
template parameter count is wrong can still be accepted by the AWS API simulation and then produce
a Meta-style failed status event, preserving the distinction between API rejection and later
provider delivery failure.

## Generic SDK walkthrough

This example discovers the WABA through the SDK, creates a template, approves that template using
the local admin API, sends with the AWS SDK, then inspects the event log. Replace the phone number
ID with a seeded ID printed at startup. The `biz_opaque_callback_data` value is copied into the
corresponding status event. Set `templates.autoApproveSeconds: -1` in the config if you want to
review the template manually; the default configuration approves it automatically.

```ts
import {
  CreateWhatsAppMessageTemplateCommand,
  ListLinkedWhatsAppBusinessAccountsCommand,
  SendWhatsAppMessageCommand,
  SocialMessagingClient,
} from '@aws-sdk/client-socialmessaging'

const endpoint = process.env.EUM_ENDPOINT ?? 'http://localhost:4580'
const client = new SocialMessagingClient({
  region: 'ap-south-1', endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
})

const { linkedAccounts = [] } = await client.send(new ListLinkedWhatsAppBusinessAccountsCommand({}))
const waba = linkedAccounts[0]
if (!waba) throw new Error('No WABA is seeded; add one in the emulator configuration.')

const definition = new TextEncoder().encode(JSON.stringify({
  name: 'local_order_update', language: 'en_US', category: 'UTILITY',
  parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Order {{1}} is ready.' }],
}))
const created = await client.send(new CreateWhatsAppMessageTemplateCommand({ id: waba.id, templateDefinition: definition }))
const approval = await fetch(`${endpoint}/_eum/api/templates/${created.metaTemplateId}/approve`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ generation: 1 }),
})
if (!approval.ok) throw new Error(await approval.text())

const sent = await client.send(new SendWhatsAppMessageCommand({
  originationPhoneNumberId: process.env.EUM_PHONE_NUMBER_ID!, metaApiVersion: 'v20.0',
  message: new TextEncoder().encode(JSON.stringify({
    messaging_product: 'whatsapp', to: '+15550000001', type: 'template',
    biz_opaque_callback_data: 'order-123',
    template: { name: 'local_order_update', language: { code: 'en_US' }, components: [
      { type: 'body', parameters: [{ type: 'text', text: 'ORDER-123' }] },
    ] },
  })),
}))
console.log('AWS message ID:', sent.messageId)
const { messages } = await (await fetch(`${endpoint}/_eum/api/messages`)).json()
const outbound = messages.find((message: { awsMessageId?: string }) => message.awsMessageId === sent.messageId)
if (!outbound) throw new Error('The sent message was not found in the local inbox.')
await new Promise((resolve) => setTimeout(resolve, 3500)) // default flow emits sent, delivered, read over 3 seconds
const detail = await (await fetch(`${endpoint}/_eum/api/messages/${encodeURIComponent(outbound.wamid)}`)).json()
console.log('Meta WAMID and status events:', outbound.wamid, detail.history, detail.events)
const reply = await fetch(`${endpoint}/_eum/api/inbound`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    phoneNumberId: process.env.EUM_PHONE_NUMBER_ID, from: '+15550000001', type: 'interactive',
    interactiveType: 'button_reply', id: 'confirm', title: 'Confirm', contextMessageId: outbound.wamid,
  }),
})
if (!reply.ok) throw new Error(await reply.text())
```

For a correlated customer reply, use the inbox composer after selecting an outbound message and
enable **Quote selected**. The generic admin equivalent is:

```json
{
  "phoneNumberId": "PHONE_NUMBER_ID",
  "from": "+15550000001",
  "type": "interactive",
  "interactiveType": "button_reply",
  "id": "confirm",
  "title": "Confirm",
  "contextMessageId": "wamid.ORIGINAL_OUTBOUND_ID"
}
```

The inbound webhook contains its own message ID and `context.id` equal to the supplied Meta WAMID.
The emulator checks that the referenced outbound message belongs to the same phone and customer.
Native `button` replies preserve `text` and `payload` separately; `list_reply` also supports an
optional `description`. URL buttons are presented as links and do not create inbound quick replies.

Manual template decisions use `POST /_eum/api/templates/:id/{approve|reject|pause|disable}` with a
JSON body such as `{"generation": 2, "expectedStatus": "PENDING", "reason": "INVALID_FORMAT"}`.
The expected status prevents stale UI actions from overriding a newer decision. Event destinations with a
failed delivery can be retried using `POST /_eum/api/events/:eventId/replay` and
`{"destination": "arn:aws:sns:..."}`. Replay resends the stored EUM event; it does not send the
WhatsApp message again.

## HTTP endpoints

| Path | Purpose |
| --- | --- |
| `/v1/...` | AWS End User Messaging Social API endpoint used by SDK clients |
| `/_eum/health` | Health check |
| `/_eum/ui/` | Browser inbox for conversations, templates, and event inspection |
| `/_eum/api/...` | Emulator administration API used by the inbox |

Messages, simulated status changes, customer replies, and events are stored in the local database.
When configured, event envelopes are also sent to the configured SNS-compatible destination or
webhook. A delivery error is recorded locally and does not turn a successful simulated send into an
AWS API failure.

## LocalStack event integration

The [example Compose file](https://github.com/GyanKumar62065/eum-social-local-emulator/blob/main/docker-compose.example.yml)
starts LocalStack and the emulator, then provisions an SNS topic and SQS subscription for inspecting
events. This file is in the source repository and is not included in the npm package.

```sh
docker compose -f docker-compose.example.yml up --build
```

The inbox is available at `http://localhost:4580`. The LocalStack endpoint is
`http://localhost:4566`. To run the opt-in SNS-to-SQS integration check when LocalStack is running:

```sh
bun run test:e2e
```

Set `EUM_E2E_LOCALSTACK` to use a different LocalStack endpoint. This check is intended for the
source repository and is not included in the published runtime package.

## Development commands

These commands are for a clone of the [source repository](https://github.com/GyanKumar62065/eum-social-local-emulator),
not an installed npm package.

```sh
bun install --frozen-lockfile
bun run ui:dev       # UI development server
bun run ui:build     # Build UI assets
bun run dev          # Run server with Node watch mode
bun run start        # Run server
bun run typecheck
bun run test
```

To refresh the vendored API model when updating against a newer AWS service model:

```sh
bun run models:update
```

Review the model source, generated operation behavior, and this README's support notes before
releasing an updated emulator. The model update script requires network access to the upstream AWS
model source.

## Package maintenance and public publishing

The package is scoped as `@gyankumar62065/eum-social-local-emulator` and configured for public
registry access. Authenticate to npm as the owner of the scope, then from the repository root:

```sh
bun install --frozen-lockfile
bun publish --access public
```

The package's `prepack` script builds the inbox UI; the allowlist in `package.json` includes the
command, runtime source, service model, built UI, example configuration, and README. It excludes
local configuration, databases, tests, and development-only files. Review the package contents and
version before each publish. The npm package is independent of the GitHub repository's visibility;
the source repository is currently public as well.

## Design

The original architecture is described in the
[initial design](https://github.com/GyanKumar62065/eum-social-local-emulator/blob/main/docs/specs/2026-10-07-eum-social-local-emulator-design.md). The current generic
compatibility and lifecycle scope is in the
[completeness specification](https://github.com/GyanKumar62065/eum-social-local-emulator/blob/main/docs/specs/2026-10-09-generic-emulator-completeness-design.md), with
its implementation breakdown in the
[implementation plan](https://github.com/GyanKumar62065/eum-social-local-emulator/blob/main/docs/superpowers/plans/2026-10-09-generic-emulator-completeness.md).

## License

This project is licensed under the [MIT License](LICENSE).
