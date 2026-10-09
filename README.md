# eum-local

A local emulator for **AWS End User Messaging Social** (WhatsApp, service `socialmessaging`).
Point the real AWS SDK at it with an endpoint override. It accepts the current AWS API, simulates
template approval, sent → delivered → read, Meta's delayed failures, the 24-hour window, and
customer replies. It publishes EUM event envelopes to SNS-compatible endpoints and includes a
browser inbox for inspecting conversations and replying as the customer.

Design: [docs/specs/2026-10-07-eum-local-design.md](docs/specs/2026-10-07-eum-local-design.md)

## Quick start

Requires Node.js 24 or newer.

```sh
npm ci
npm run ui:build
cp eum-local.example.yaml eum-local.yaml
EUM_CONFIG=./eum-local.yaml npm start
```

The server listens on port 4580 by default. Open [http://localhost:4580](http://localhost:4580)
for the inbox, or [http://localhost:4580/_eum/health](http://localhost:4580/_eum/health) for
health. Configure the AWS SDK's endpoint override as `http://localhost:4580` and use region
`ap-south-1` with local credentials (for example `test` / `test`).

To run without LocalStack, remove the `aws:` section from the config. Events remain visible in the
local event store. The example config seeds a WABA, phone number, and approved template; startup
prints their generated AWS resource IDs.

## LocalStack

Docker Compose starts LocalStack (SNS, SQS, S3) and eum-local, then creates an SNS topic and an SQS
subscription for inspecting events:

```sh
docker compose -f docker-compose.example.yml up --build
```

The inbox is at `http://localhost:4580`. Configure your application SDK's endpoint override to
that address. Use `npm run test:e2e` to run the opt-in SNS → SQS integration test when LocalStack
is available at `http://localhost:4566` (or set `EUM_E2E_LOCALSTACK`).

## Java SDK smoke test

With eum-local running and the example seed loaded, run:

```sh
cd test/java
mvn compile exec:java -Dexec.args="http://localhost:4580 phone-number-id-c9b741dedd84bbe1c433fe12b5dd9c0a"
```

The smoke test exercises AWS SDK v2 phone lookup, template send, and modeled
`ResourceNotFoundException` error mapping.

## API and simulator

The emulator routes the vendored Smithy service model through `/v1/...`; unsupported operations
return modeled HTTP 501 errors. Simulated AWS IDs and seeded operations are listed at startup. The
admin API and inbox are under `/_eum/api/` and `/_eum/ui/`. Configuration controls WABAs, phone
numbers, templates, message status flows, injected Meta failures, AWS endpoints, and persistence.

Run the unit suite and type checker with:

```sh
npm test
npm run typecheck
```
