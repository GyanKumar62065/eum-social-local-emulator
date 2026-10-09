# EUM Social Local Emulator — a local emulator for AWS End User Messaging

- **Date:** 2026-10-07
- **Status:** Draft, awaiting review
- **Scope of v1:** AWS End User Messaging **Social** (WhatsApp, service `socialmessaging`). SMS/Voice v2 (`pinpoint-sms-voice-v2`) is the planned v2 module; Push (legacy Pinpoint) is out of scope.

## 1. Problem and goal

Applications can send WhatsApp through AWS End User Messaging Social with the AWS SDK's
`SocialMessagingClient.sendWhatsAppMessage` operation. Neither LocalStack nor a public library
emulates EUM Social, so local development and CI otherwise need a real AWS account, a real Meta
WABA, and real phone numbers.

**Goal:** a local server that the *unmodified* AWS SDKs can talk to (only `endpointOverride`
changes), which:

1. Accepts the current EUM Social API on the wire, with AWS-shaped success and error responses.
2. Simulates the WhatsApp side realistically: template approval, asynchronous delivery status,
   Meta's asynchronous failures, the 24-hour customer-service window, inbound replies.
3. Emits the **real EUM event envelope** to the WABA's event destinations (SNS on LocalStack),
   so status, stats and suppression code paths run end to end.
4. Gives developers a browser inbox to see what was "sent" and to act as the customer.

**Who it is for:** developers working locally and CI pipelines. Not a load-testing
tool, not for production, no security boundary.

### Success criteria

- `@aws-sdk/client-socialmessaging` (JS v3) and the Java SDK 2.46.7 can call every simulated
  operation against eum-social-local-emulator with no code change besides endpoint + dummy credentials.
- A `SendWhatsAppMessage` produces `sent → delivered → read` events on a LocalStack SNS topic,
  received by an SQS subscriber, with the envelope documented by AWS (§6.3).
- A developer can open `/_eum/ui`, see the rendered message, and reply "STOP" as the customer,
  producing an inbound `messages` event on the same topic.
- Upgrading to a newer AWS model (`bun run models:update`) exposes new operations as routed,
  validated endpoints without hand-written code.

## 2. Decisions taken (and why)

| Decision | Choice | Reason |
|---|---|---|
| First channel | EUM Social (WhatsApp) | It is the only EUM API the codebase calls today. |
| Developer experience | Headless store + admin API **and** browser inbox with manual controls | CI needs headless rules; opt-out/status testing needs "act as the customer". |
| Implementation | TypeScript service **driven by the official AWS Smithy model** | "Latest interface" stays true by refreshing a model file, not by hand-checking SDK releases. |
| Rejected: LocalStack extension | — | Couples to LocalStack internals and versions; hosting a UI is awkward; some extension features are Pro-only. |
| Rejected: Spring Boot service | — | Every route and shape hand-written; drifts from AWS silently. |
| Location | New repo `/Users/gyankumar/Works/eum-social-local-emulator` | Standalone tool used by several repos. |

## 3. The interface being emulated

Source of truth: `models/socialmessaging-2024-01-01.json`, vendored from
`github.com/aws/api-models-aws` (`models/socialmessaging/service/2024-01-01/`), upstream commit
`a877f97` (2026-09-17). The file's commit is recorded in `models/SOURCE` on every update.

Facts taken from the model:

- Protocol `aws.protocols#restJson1`, auth `aws.auth#sigv4`, signing name `social-messaging`.
- **38 operations.** None use `@httpLabel`; inputs bind via `@httpQuery` or the JSON body.
- Error shapes and HTTP status (from `@httpError`), all with a single `message` member:
  `AccessDeniedByMetaException` 403, `AccessDeniedException` 403, `ConflictException` 409,
  `DependencyException` 502, `InternalServiceException` 500, `InvalidParametersException` 400,
  `LimitExceededException` 400, `ResourceNotFoundException` 404, `ThrottledRequestException` 429,
  `ValidationException` 400.

Note: the newest model has 7 operations the project's SDK 2.46.7 does not know
(calling ×2, dataset/conversion ×2, business public key ×2, `UpdateLinkedWhatsAppBusinessAccountPhoneNumber`).
That is expected; eum-social-local-emulator tracks AWS, not a particular SDK.

### 3.1 Operation coverage in v1

**Simulated (22):**

| Area | Operations |
|---|---|
| WABA & phone numbers | `AssociateWhatsAppBusinessAccount`, `DisassociateWhatsAppBusinessAccount`, `GetLinkedWhatsAppBusinessAccount`, `ListLinkedWhatsAppBusinessAccounts`, `GetLinkedWhatsAppBusinessAccountPhoneNumber`, `UpdateLinkedWhatsAppBusinessAccountPhoneNumber` |
| Events | `PutWhatsAppBusinessAccountEventDestinations` |
| Messaging | `SendWhatsAppMessage` |
| Templates | `CreateWhatsAppMessageTemplate`, `CreateWhatsAppMessageTemplateFromLibrary`, `GetWhatsAppMessageTemplate`, `ListWhatsAppMessageTemplates`, `UpdateWhatsAppMessageTemplate`, `DeleteWhatsAppMessageTemplate`, `ListWhatsAppTemplateLibrary`, `CreateWhatsAppMessageTemplateMedia` |
| Media | `PostWhatsAppMessageMedia`, `GetWhatsAppMessageMedia`, `DeleteWhatsAppMessageMedia` |
| Tags | `TagResource`, `UntagResource`, `ListTagsForResource` |

**Routed and validated, not simulated (16):** Flows ×10 (`Create/Get/GetPreview/List/Update/Publish/Deprecate/Delete WhatsAppFlow`, `ListWhatsAppFlowAssets`, `UpdateWhatsAppFlowAssets`), calling (`GetWhatsAppCallPermission`, `SendWhatsAppCallEvent`), datasets (`CreateWhatsAppDataset`, `SendWhatsAppConversionEvent`), `GetWhatsAppBusinessPublicKey`, `PutWhatsAppBusinessPublicKey`, and any operation added by a future model refresh.
These validate input like any other operation, then return **HTTP 501** with
`x-amzn-ErrorType: InternalServiceException` and message
`eum-social-local-emulator: <OperationName> is not simulated yet`. Never a fake success.

The exact simulated/not-simulated split is computed at startup (model operations minus
registered handlers) and printed in the startup log and at `GET /_eum/api/coverage`.

## 4. Architecture

One Node 24 LTS process, TypeScript, one port (default **4580**).

| Path prefix | Purpose |
|---|---|
| `/v1/...` | EUM Social API (what the SDKs call) |
| `/_eum/api/...` | Admin & inspection REST API |
| `/_eum/ui` | Inbox UI (static build) |
| `/_eum/health` | Liveness/readiness |

```
eum-social-local-emulator/
  models/                 vendored Smithy JSON + SOURCE (upstream commit, date)
  scripts/update-models.ts
  src/
    server.ts             Fastify bootstrap, wires everything
    config.ts             loads eum-social-local-emulator.yaml + env overrides
    smithy/
      model.ts            loads the JSON AST, resolves shapes
      router.ts           builds (method, uri) → operation table from @http traits
      bind.ts             request → input object (query, headers, body), output → response
      validate.ts         required, length, range, pattern, enum, blob(base64), list/map, nested
      errors.ts           AwsError(type, message) → status + x-amzn-ErrorType + {message}
    services/socialmessaging/
      index.ts            handler registry: operationName → handler
      waba.ts  send.ts  templates.ts  media.ts  tags.ts
    domain/
      ids.ts              AWS ids/ARNs, Meta ids, wamid generation
      window.ts           24h customer-service window
      templates.ts        placeholder counting, rendering
    store/
      db.ts               node:sqlite, migrations
      repos/*.ts          one repo per table
    sim/
      simulator.ts        schedules status transitions per message
      rules.ts            outcome rules (match → outcome)
      clock.ts            injectable clock + scheduler (tests use a fake clock)
    events/
      envelope.ts         builds the AWS EUM envelope around a Meta webhook entry
      sinks/sns.ts        publishes to SNS (LocalStack) via @aws-sdk/client-sns
      sinks/http.ts       optional: POST envelope to a URL
      sinks/memory.ts     always on: event log in the store (feeds UI + admin API)
      bus.ts              fan-out + SSE broadcast
    admin/routes.ts
  ui/                     Preact + Vite; built into ui/dist, served statically
  test/
  docs/specs/
```

### 4.1 Request pipeline

1. **Route** — `router.ts` matches method + path (+ required query keys when two operations
   share a path, e.g. `GET /v1/whatsapp/template` vs `POST /v1/whatsapp/template`) to an
   operation. Unknown route → 404 `UnknownOperationException`-style error with the AWS header.
2. **Auth** — require an `Authorization` header starting with `AWS4-HMAC-SHA256`; signature is
   **not** verified. Region and account id used in ARNs come from config (defaults
   `ap-south-1`, `000000000000`) so seeded ARNs are stable; the credential-scope region is
   ignored. Missing header → 403 `AccessDeniedException`.
3. **Bind** — build the input object from `@httpQuery` members and the JSON body; blobs arrive
   base64 in JSON and are decoded.
4. **Validate** — walk the input shape and apply constraint traits. First violation →
   400 `ValidationException` with a message naming the member path, e.g.
   `1 validation error detected: Value null at 'originationPhoneNumberId' failed to satisfy constraint: Member must not be null`.
5. **Dispatch** — handler from the registry, or the 501 path (§3.1).
6. **Serialize** — output object → JSON per output shape (blobs base64, timestamps per the
   member's `@timestampFormat`, default epoch-seconds for restJson1). Add
   `x-amzn-RequestId` (UUID) to every response.

Handlers throw `AwsError(type, message)`; the error type must exist in the operation's
`errors` list in the model, else it is reported as `InternalServiceException` and logged as
an eum-social-local-emulator bug.

### 4.2 Adding SMS/Voice v2 later

`pinpoint-sms-voice-v2` uses the `awsJson1_0` protocol (`POST /` with `X-Amz-Target`). It
gets its own model file, a protocol adapter in `smithy/` (target-header routing + JSON body),
its own handler folder, and its **own port** (4581) so endpoint overrides stay simple. Not
built in v1; the only v1 requirement is that `smithy/` keeps protocol-specific code
(`router.ts`, `bind.ts`) separate from protocol-neutral code (`model.ts`, `validate.ts`,
`errors.ts`).

## 5. Data model (SQLite, `node:sqlite`)

Database file defaults to `./data/eum-local.db`; `EUM_DB=:memory:` for tests/CI.

| Table | Key columns |
|---|---|
| `waba` | `id` (AWS id, `waba-<32 hex>`), `arn`, `meta_waba_id`, `name`, `registration_status`, `link_date`, `event_destinations`, `associate_token` |
| `phone_number` | `id` (`phone-number-id-<32 hex>`), `arn`, `waba_id`, `meta_phone_number_id`, `phone_number` (E.164), `display_phone_number`, `display_name`, `quality_rating`, `data_localization_region`, `call_settings` |
| `template` | `meta_template_id`, `waba_id`, `name`, `language`, `category`, `status` (`PENDING`/`APPROVED`/`REJECTED`/`PAUSED`/`DISABLED`), `components_json`, `created_at`, `updated_at` |
| `message` | `wamid`, `aws_message_id`, `phone_number_id`, `direction` (`out`/`in`), `peer` (customer E.164), `type`, `body`, `rendered_text`, `category`, `status`, `error_code`, `error_title`, `created_at` |
| `message_status` | `wamid`, `status`, `error_code`, `at` |
| `media` | `media_id`, `owner_id` (phone-number id, or WABA id for template media), `mime_type`, `sha256`, `bytes` (BLOB), `created_at` |
| `tag` | `resource_arn`, `key`, `value` |
| `event` | `id`, `kind` (`status`/`inbound`/`template_status`), `envelope_json`, `destinations_json`, `delivery_result_json`, `at` |

The 24-hour window is derived (latest inbound `message.created_at` for the phone number + peer),
not stored. **AWS ids are derived from Meta ids** (`waba-` / `phone-number-id-` + first 32 hex of
SHA-256 of the Meta id), so they are identical across restarts and `reset` — app config that
names a `phone-number-id-…` keeps working. Schema is created with `CREATE TABLE IF NOT EXISTS`
(no migration framework in v1).

ARN formats follow the AWS docs example:
`arn:aws:social-messaging:<region>:<account>:waba/<id>` and
`arn:aws:social-messaging:<region>:<account>:phone-number-id/<id>`.

## 6. Behaviour

### 6.1 Seeding and WABA operations

`AssociateWhatsAppBusinessAccount` is console-only in real AWS, so WABAs come primarily from
config, loaded (idempotently, by `meta_waba_id`) at startup:

```yaml
# eum-social-local-emulator.yaml
region: ap-south-1
accountId: "000000000000"
aws:
  endpoint: http://localstack:4566       # SNS sink + S3 media; omit to disable both
wabas:
  - name: Example Business
    metaWabaId: "100000000000001"
    eventDestinations:
      - arn:aws:sns:ap-south-1:000000000000:eum-whatsapp-events
    phoneNumbers:
      - phoneNumber: "+919800000001"
        displayName: Example Sender
        metaPhoneNumberId: "200000000000001"
    templates:
      - name: invoice_reminder
        language: en
        category: UTILITY
        status: APPROVED
        components:
          - type: BODY
            text: "Hi {{1}}, invoice {{2}} of {{3}} is due on {{4}}."
templates:
  autoApproveSeconds: 0          # 0 = approve immediately; -1 = manual only
sim:
  defaultFlow: [sent, delivered, read]
  stepDelayMs: 1000
  rules:
    - match: { to: "*0000" }
      outcome: { status: failed, code: 131026, title: "Message undeliverable" }
    - match: { to: "*1111" }
      outcome: { flow: [sent, delivered] }   # never read
messageIdMode: uuid              # uuid | wamid  (see §10)
```

`Associate` is also accepted (any `signupCallback`/`setupFinalization` input that validates)
and creates a WABA with generated ids, so tests can create WABAs through the API.
Seeded WABAs must give `metaWabaId`, and each phone number `metaPhoneNumberId` (digits), so ids
stay stable. `Disassociate` removes the WABA, its phone numbers and their messages; later sends
from those numbers → `ResourceNotFoundException`. `PutWhatsAppBusinessAccountEventDestinations`
on an unknown WABA → `InvalidParametersException` (the model does not list `ResourceNotFound`
for that operation). `Get`/`List` paginate with an opaque base64 `nextToken`.

### 6.2 SendWhatsAppMessage

Synchronous checks (failure = error response, nothing stored):

| Check | Error |
|---|---|
| `originationPhoneNumberId` unknown (accepts AWS id **or** its ARN) | `ResourceNotFoundException` |
| owning WABA disassociated | `ResourceNotFoundException` |
| `message` is not valid JSON, or missing `messaging_product: "whatsapp"`, `to`, `type` | `InvalidParametersException` |
| `metaApiVersion` not matching `^v\d+\.\d+$` | `InvalidParametersException` |

On success: store the message, return `{ messageId }`, then hand it to the simulator.

Asynchronous outcome (first match wins), emitted as status events like real Meta:

1. `type: template` and the template is not found in this WABA, or not `APPROVED`, or the
   language differs → `failed`, code **132001** ("Template name does not exist in the translation").
2. Template parameter count (body `{{n}}` placeholders vs supplied body parameters) differs →
   `failed`, code **132000** ("Number of parameters does not match the expected number of params").
3. Non-template type and no inbound message from this `peer` in the last 24 h → `failed`,
   code **131047** ("Re-engagement message").
4. First matching `sim.rules` entry (glob on `to`, optional `type`/`template`) → its outcome.
5. Otherwise `sim.defaultFlow`, one step every `stepDelayMs`.

Templates are rendered (placeholders substituted) into `rendered_text` for the UI.
Supported outbound types for rendering: `text`, `template`, `image`, `document`, `video`,
`audio`, `interactive` (shown as JSON), `reaction`. Others are stored and shown raw.

### 6.3 Event envelope and delivery

Every status, inbound message and template status change is wrapped exactly as AWS documents
("Message and event format in AWS End User Messaging Social"):

```json
{
  "context": {
    "MetaWabaIds": [{ "wabaId": "<meta waba id>", "arn": "<waba arn>" }],
    "MetaPhoneNumberIds": [{ "metaPhoneNumberId": "<meta phone id>", "arn": "<phone arn>" }]
  },
  "whatsAppWebhookEntry": "<JSON string of the Meta webhook entry>",
  "aws_account_id": "000000000000",
  "message_timestamp": "2026-10-07T10:00:00.123456789Z",
  "messageId": "<uuid for this event>"
}
```

The Meta webhook entry is `{ id: <meta waba id>, changes: [{ field, value }] }` where `value`
follows the Meta Cloud API webhook reference:

- status: `field: "messages"`, `value.statuses[]` with `id` (wamid), `status`, `timestamp`,
  `recipient_id`, `conversation`, `pricing`; for failures `errors[{ code, title, message, error_data }]`.
- inbound: `field: "messages"`, `value.contacts[]` + `value.messages[]` (`text`, `image`,
  `button`, `interactive` reply types).
- template status: `field: "message_template_status_update"`, `value { event, message_template_id, message_template_name, message_template_language, reason }`.

`value.metadata` always carries `display_phone_number` and `phone_number_id` (Meta id).

**Sinks:** the event is stored (memory sink, always), then published to every
`eventDestinationArn` on the WABA:

- `arn:aws:sns:...` → `Publish` on the configured SNS endpoint (LocalStack), message = envelope JSON.
- anything else → recorded as `skipped: unsupported destination` (real EUM also accepts
  Amazon Connect instances; not emulated).

Publish failures (LocalStack down, topic missing) are recorded on the event row and shown in
the UI; they never fail the API call that caused them. No retries in v1.

### 6.4 Templates

- `Create` stores with status `PENDING`; a scheduler moves it to `APPROVED` after
  `autoApproveSeconds` (or never, when `-1`). Approve/reject via admin API or UI; each change
  emits a `message_template_status_update` event.
- `CreateFromLibrary` copies from a small built-in library of Meta utility templates
  (`src/services/socialmessaging/library.json`), which `ListWhatsAppTemplateLibrary` also lists.
- `Update` re-sets status to `PENDING` (Meta re-reviews edits). `Delete` by name or id.
- Name rules enforced: lowercase, digits, underscores, ≤ 512 chars; duplicate name+language
  in a WABA → `InvalidParametersException`.

### 6.5 Media

- `PostWhatsAppMessageMedia` reads the file from `sourceS3File {bucketName, key}` via S3 on the
  configured LocalStack endpoint, or fetches `sourceS3PresignedUrl`; stores bytes, returns a
  Meta-style numeric `mediaId`. Unreachable source → `InvalidParametersException`.
- `GetWhatsAppMessageMedia` writes the bytes to `destinationS3File` (or presigned URL);
  `metadataOnly: true` returns only `mimeType`/`fileSize`.
- `DeleteWhatsAppMessageMedia` removes it. Max 100 MB per file.
- Inbound media sent from the UI is stored the same way, so `GetWhatsAppMessageMedia` works on
  media "received" from a customer.

### 6.6 Tags

Generic key/value storage per resource ARN (WABA and phone-number ARNs); unknown ARN →
`InvalidParametersException` (the tagging operations do not declare `ResourceNotFound`).

## 7. Admin API (`/_eum/api`)

| Method & path | Purpose |
|---|---|
| `GET /coverage` | simulated vs not-simulated operations, model commit |
| `GET /wabas`, `POST /wabas` | list / create WABAs (same shape as the YAML) |
| `GET /messages?phoneNumberId=&peer=&status=` | list messages with status history |
| `GET /messages/:wamid` | one message, raw request, rendered text, events |
| `POST /messages/:wamid/status` | `{ status, code?, title? }` push a status by hand |
| `POST /inbound` | `{ phoneNumberId, from, name?, type, text?, mediaBase64?, mimeType? }` customer reply |
| `POST /templates/:id/approve`, `/reject` | `{ reason? }` |
| `GET /events?kind=` | event log with delivery results |
| `GET /stream` | SSE: `message`, `status`, `event` |
| `POST /reset` | wipe all data, then re-seed from config |

No auth on the admin API (local tool). It binds to `0.0.0.0` inside Docker; the docs tell
developers not to expose the port beyond localhost.

## 8. Inbox UI (`/_eum/ui`)

- **Left:** WABA → phone number → conversations (by customer number), unread counts.
- **Centre:** chat thread. Outbound bubbles show rendered template text and status ticks
  (sent ✓, delivered ✓✓, read blue ✓✓, failed ⚠ with code). Inbound bubbles on the left.
  A composer at the bottom sends a reply **as the customer** (text, button reply, image), with
  a one-click **STOP** button.
- **Right:** selected message's raw `SendWhatsAppMessage` payload, status timeline, emitted
  envelopes with SNS delivery result, and actions: mark delivered / read / failed (code picker
  with the common Meta codes 131026, 131047, 131049, 131050, 132000, 132001).
- **Top bar:** templates page (list, approve, reject), events page, **Reset all**.
- Live updates via SSE. Built with Preact + Vite; no other runtime dependencies.

## 9. Error handling summary

- AWS-facing errors: only shapes listed for that operation in the model; correct HTTP status,
  `x-amzn-ErrorType: <Name>`, body `{ "message": "..." }`, `x-amzn-RequestId`.
- Unexpected exceptions in handlers → 500 `InternalServiceException`, stack in the log.
- Sink failures → recorded, never surfaced to the API caller.
- Bad config file → process exits at startup with the YAML path and reason.

## 10. Open question (verify once against real AWS)

The AWS docs do not state whether `SendWhatsAppMessageOutput.messageId` equals Meta's
`wamid` (the `statuses[].id` in later events) or is a separate AWS id. This decides how
callers correlate a send with its status events. Default `messageIdMode: uuid` returns a UUID
and uses a separate wamid in events; `messageIdMode: wamid` returns the wamid. **Action:** one
real send in an authorized AWS development account, compare the response with the first status event,
then set the default to match and note the result here.

## 11. Testing

- **Unit (vitest):** `smithy/validate`, `smithy/router` (all 38 operations resolve, no
  ambiguous routes), `domain/templates` (placeholder counting/rendering), `sim/rules`,
  `domain/window`, `events/envelope` (snapshot against the AWS doc example structure).
- **Contract (vitest + `@aws-sdk/client-socialmessaging`):** server started in-process with
  `EUM_DB=:memory:` and a fake clock; every simulated operation called through the real SDK,
  including error cases (assert the SDK surfaces the right exception class); one call to a
  not-simulated operation asserts the 501 `InternalServiceException`.
- **End-to-end (opt-in, `bun run test:e2e`):** docker compose with LocalStack; create SNS
  topic → SQS subscription; send; assert `sent`, `delivered`, `read` envelopes arrive in SQS;
  post an inbound STOP; assert the inbound envelope.
- **Java smoke (opt-in, `test/java/`):** a small Maven project on
  `software.amazon.awssdk:socialmessaging:2.46.7` + `url-connection-client` that sends one
  template message to the emulator.
- **Model refresh check:** `bun run models:update` followed by the unit + contract suites;
  new upstream operations must appear as not-simulated without failing.

## 12. Packaging

- `Dockerfile`: multi-stage, `node:24-alpine`, builds server + UI, runs as non-root,
  `HEALTHCHECK` on `/_eum/health`, config at `/etc/eum-social-local-emulator/eum-social-local-emulator.yaml`, data volume at `/data`.
- `docker-compose.example.yml`: eum-social-local-emulator + LocalStack (SNS, SQS, S3) + an init script that
  creates the example topic.
- `README.md`: quick start, SDK snippets (JS, Java, Python/boto3) with `endpointOverride`
  and dummy credentials, config reference, limits.

## 13. Out of scope for v1

- SMS/Voice v2 and Push.
- SigV4 signature verification, IAM policy evaluation.
- Amazon Connect event destinations, SNS retries/DLQs.
- Flows, calling, datasets, business public key behaviour (routed + 501 only).
- Meta rate limits, quality-rating changes, messaging-tier limits.
- Wiring application-specific code to it. Configure each SDK client with the local endpoint
  override described in the README.
