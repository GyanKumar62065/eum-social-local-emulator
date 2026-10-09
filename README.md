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

## Install the private package

The package is prepared as a **restricted scoped npm package**. Replace `gyankumar62065` below
with the npm username that owns the package scope. Your npm account must have access to the private
package. npm requires a paid user or organization account to publish private packages. Bun is used
for installation and scripts in this project; it can install scoped packages from the npm registry.

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

The package can also be installed as a project dependency with `bun add` and its command run via
`bunx`. The server reads configuration from the current working directory by default, so set
`EUM_CONFIG` when the config is elsewhere. Keep the package access token in your normal registry
configuration; never put it in source control.

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

A small Java smoke-test project is included in the source repository under `test/java`:

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
| `host` | `0.0.0.0` | Bind address |
| `dbPath` | `./data/eum-local.db` | SQLite database path |
| `region` | `ap-south-1` | Region used in generated ARNs and SDK integration |
| `accountId` | `000000000000` | Account ID used in generated ARNs |
| `aws.endpoint` | unset | Optional AWS-compatible endpoint for SNS events and S3 media; unset disables those integrations |
| `webhookUrl` | unset | Optional webhook event destination |
| `wabas` | `[]` | WABA seeds, including `name`, numeric `metaWabaId`, `eventDestinations`, `phoneNumbers` and `templates` |
| `templates.autoApproveSeconds` | `0` | `0` approves immediately; `-1` leaves templates for manual review in the inbox |
| `sim.defaultFlow` | `[sent, delivered, read]` | Default status progression for simulated messages |
| `sim.stepDelayMs` | `1000` | Delay between status events |
| `sim.rules` | `[]` | Ordered recipient/type/template match rules for simulated failure or custom status flow |
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

The example Compose file starts LocalStack and the emulator, then provisions an SNS topic and SQS
subscription for inspecting events:

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

## Package maintenance and private publishing

The package is scoped as `@gyankumar62065/eum-social-local-emulator` and configured for restricted
registry access. Ensure the npm account has permission to publish restricted packages. Authenticate
with the npm registry, then from the repository root:

```sh
bun install --frozen-lockfile
bun publish --access restricted
```

The package's `prepack` script builds the inbox UI; the allowlist in `package.json` includes the
command, runtime source, service model, built UI, example configuration, and README. It excludes
local configuration, databases, tests, and development-only files. Review the package contents and
version before each publish. Publishing is a separate release action and is not performed by this
project setup.

## Design

The design and API behavior are documented in
[`docs/specs/2026-10-07-eum-social-local-emulator-design.md`](docs/specs/2026-10-07-eum-social-local-emulator-design.md).

## License

This project is licensed under the [MIT License](LICENSE).
