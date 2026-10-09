# AWS End User Messaging Social Emulator: Generic Compatibility and Lifecycle Design

- **Date:** 2026-10-09
- **Status:** Draft for review
- **Target:** `@gyankumar62065/eum-social-local-emulator`
- **Baseline reviewed:** published package `0.1.1` and repository source

## 1. Purpose

Close the documented compatibility and local-development gaps in the AWS End User Messaging
Social (WhatsApp) emulator while keeping it useful to any application that uses the AWS SDK.
AWS SDK request/response shapes and the AWS EUM event envelope remain the compatibility boundary.
The emulator does not own application-specific policy, identity, tenancy, deployment, or provider
selection.

This document records the requested behavior and a proposed implementation direction. The
published-package comparison in the supplied requirements is source inspection, not a claim that
the listed behavior has passed an executed compatibility suite.

## 2. Goals

1. Preserve the existing nine AWS SDK operations, stable seeded identifiers, persistence,
   registration states, template moderation, simulated delivery progression, SNS integration,
   inbox, and health endpoint.
2. Make outbound messages, delivery callbacks, inbound replies, and button/list interactions
   correlate using provider identifiers and supported Meta payload fields.
3. Preserve template definitions and render/validate their supported component types without
   application-specific rewriting.
4. Make template state transitions generation-safe and event delivery failures observable and
   replayable.
5. Produce AWS-modeled failures for unsupported or invalid operations rather than successful no-op
   responses.
6. Keep local startup, persistence, configuration, and package contents suitable for generic
   Node.js development use.

## 3. Non-goals and genericity boundary

- No application-specific approval rules, namespaces, bindings, readiness policies, or deployment
  modes.
- No application-specific IDs or hard-coded customer data.
- No production delivery guarantee, AWS service replacement claim, or load-testing guarantee.
- No change to AWS event-envelope structure to accommodate a particular consumer. Consumers that
  require another webhook shape should adapt at their own integration boundary.
- No new EUM service families beyond the existing Social/WhatsApp scope.

## 4. Existing compatibility surface to preserve

The following operations remain supported with AWS field casing, Smithy serialization, blob/byte
handling, pagination, and modeled errors:

1. `ListLinkedWhatsAppBusinessAccounts`
2. `GetLinkedWhatsAppBusinessAccount`
3. `GetLinkedWhatsAppBusinessAccountPhoneNumber`
4. `PutWhatsAppBusinessAccountEventDestinations`
5. `CreateWhatsAppMessageTemplate`
6. `UpdateWhatsAppMessageTemplate`
7. `GetWhatsAppMessageTemplate`
8. `ListWhatsAppMessageTemplates`
9. `SendWhatsAppMessage`

Keep stable seeded IDs/ARNs, SQLite persistence, `COMPLETE`/`INCOMPLETE` registration states,
manual template decisions, automatic message status progression, the SNS-compatible event sink,
browser inbox, and `/_eum/health`.

## 5. Proposed design

### 5.1 Message and inbound-interaction correlation

- Preserve `biz_opaque_callback_data` supplied in the outbound WhatsApp message body.
- Include that value in every corresponding sent, delivered, read, or failed status object where
  the Meta callback format supports it.
- Model the AWS `SendWhatsAppMessage` response ID and Meta WAMID as separate values. They may
  happen to match in a simulation profile, but the implementation must not require equality or
  expose an application-specific substitute field.
- Add an inbox/admin action to reply to a selected outbound message. The request may include the
  original Meta WAMID; when supplied, emit it as `messages[].context.id` exactly. Generate a
  distinct inbound message ID.
- Validate a quoted message belongs to the same originating phone number and customer. Reject
  invalid cross-customer or cross-phone references with a clear admin API error.
- Keep ordinary, unquoted inbound messages supported.
- Represent visible button text separately from its payload. Support native inbound `button`
  (`text`, `payload`), `interactive.button_reply` (`id`, `title`), and
  `interactive.list_reply` (`id`, `title`, optional `description`) structures, with optional
  `context`. Preserve submitted values in emitted webhook entries. URL-button clicks navigate to
  their URL and do not create a quick-reply message.

### 5.2 Template definitions, previews, and generations

- Round-trip the submitted template definition, including components, examples, category,
  language, and parameter format, through create/update and get/list behavior wherever the AWS
  operation returns those fields.
- Validate and render supported component parameters for text HEADER, BODY, FOOTER, URL BUTTONS
  (ordered indices and dynamic URL suffixes), and AUTHENTICATION templates (security
  recommendation, expiration footer, and supported OTP/copy-code button parameters).
- Keep definition content intact. Consumers can compare the provider definition to their own
  expected content; the emulator does not rewrite it to fit a client-side approval fingerprint.
- Store a monotonically increasing definition generation for each create/update. An approval or
  rejection action targets a specific generation. Delayed decisions for an older generation must
  never alter the current definition, including when updates occur within one millisecond.
- Updating an approved template creates a new pending definition. Sending with it remains
  disallowed until that definition is approved.
- Support manual `APPROVED`, `REJECTED`, `PAUSED`, and `DISABLED` outcomes, with an inspectable
  rejection reason. Preserve AWS-compatible status serialization.

### 5.3 Delivery events and replay

- Keep `whatsAppWebhookEntry` as a JSON string containing one `{id, changes}` Meta entry, with the
  existing AWS EUM context IDs/ARNs, account ID, timestamp, and event ID in the surrounding
  envelope.
- Publish the documented AWS envelope as the SNS `Message` using the SNS SDK. LocalStack remains
  responsible for its SNS transport envelope and signatures.
- Record delivery attempts and per-destination results. A failed destination remains visible in
  the inbox and can be replayed without sending the outbound WhatsApp message again.
- Replay preserves the original provider event ID and payload. A newly created distinct event gets
  a new ID. Duplicate/replayed delivery does not create a second logical outbound message.
- Model delayed, duplicate, and out-of-order status events so applications can exercise those
  cases locally.

### 5.4 AWS-compatible failure behavior

- Return modeled AWS exceptions for denied sends, throttling, missing resources, incomplete
  registration, invalid templates, and invalid template parameters.
- Distinguish an immediate API rejection from an accepted send that later receives a failed
  delivery status.
- Every advertised-but-unsupported operation must fail with a modeled error; it must not report
  apparent success without performing its documented effect.

### 5.5 Generic local operation and documentation

- Keep Node.js 24+ as the package runtime target and include the built inbox assets and runnable
  example configuration in the published artifact.
- Preserve host/port configuration, persistent database behavior, restart-stable seed records,
  and externally configured SNS-compatible endpoints/destinations.
- Support multiple WABAs and phone numbers without hard-coded application assumptions.
- Document an official AWS SDK flow: discover account/phone → submit a template → approve it in the
  inbox → send → inspect status event → create a correlated reply. Include the corresponding admin
  API payloads, endpoint override setup, persistence/configuration, and unsupported-operation
  behavior.

## 6. Implementation approach

Extend the existing SQLite stores, service handlers, simulator, event bus/sinks, and inbox rather
than introducing a separate workflow engine. Keep AWS request binding/serialization at the
existing Smithy boundary; keep admin-only simulation controls in the admin API; keep external
SNS publishing behind the current sink abstraction. Add persisted fields/migrations for message
IDs, template generations, and delivery attempts only where the existing schema cannot represent
the required lifecycle.

Implementation is proposed in four slices:

1. Message IDs, callback data, correlated replies, and inbound button/list payloads.
2. Lossless template definitions, component validation/rendering, generation-safe decisions, and
   expanded manual states.
3. Durable SNS delivery results, replay/deduplication, and simulation of delayed/duplicate/
   out-of-order events.
4. Modeled failure coverage, inbox controls, package contents, generic examples, and documentation.

Each slice must retain compatibility with existing persisted data and seeded development
installations. Database changes need forward migrations and safe defaults for existing rows.

## 7. Acceptance criteria

1. An unmodified AWS SDK can call all nine listed operations using only an endpoint override and
   dummy local credentials.
2. Template create/update/get/list preserve the submitted definition fields, and a delayed decision
   for a stale generation cannot approve or reject a newer definition.
3. Send response ID, Meta WAMID, callback data, and subsequent status objects remain correctly
   associated even when AWS and Meta IDs differ.
4. Quoted replies and each supported button/list interaction preserve customer, phone, payload,
   and context correlation; ordinary inbound text remains valid.
5. LocalStack receives the documented AWS envelope as the SNS message; SNS failures are visible
   and replayable without a second outbound message.
6. Inbox template previews support HEADER, BODY, FOOTER, URL BUTTONS, and AUTHENTICATION content.
7. Restarting the process preserves registered numbers, template definitions/generations,
   messages, events, and delivery attempt history.
8. Invalid or unsupported requests fail with modeled errors and do not silently succeed.
9. Package documentation contains a runnable generic AWS SDK walkthrough and accurately states
   operation support and runtime requirements.

## 8. Risks and decisions to confirm

- **Schema migration:** Existing SQLite databases must remain readable; new identifiers and
  generations need deterministic backfills where possible.
- **AWS model fidelity:** Some status fields and modeled exceptions depend on the bundled AWS
  Smithy model. Confirm exact shape names and allowed enums against that model during implementation.
- **Authentication-template variants:** Provider component schemas vary. Implement only structures
  supported by the current AWS/Meta contract and explicitly reject unsupported shapes.
- **Replay semantics:** Replaying an SNS delivery should resend the same event bytes and ID to the
  selected failed destination while retaining the prior attempt history.
- **No test execution claim:** The supplied comparison was source inspection. Compatibility and
  acceptance claims require implementation-time verification before release.

## 9. Out-of-scope integration responsibilities

Applications using the emulator remain responsible for their own identity, policies, readiness,
provider selection, and webhook adaptation. The emulator provides generic AWS-compatible
simulation and event delivery controls; it does not encode a particular application's internal
ownership or deployment model.
