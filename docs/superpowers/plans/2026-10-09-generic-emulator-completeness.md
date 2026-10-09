# Generic Emulator Compatibility and Lifecycle Implementation Plan

> **For agentic workers:** Implement the approved design in `docs/specs/2026-10-09-generic-emulator-completeness-design.md` task by task in this checkout.

**Goal:** Complete the generic AWS End User Messaging Social emulator flows for message correlation, template lifecycle and previews, event delivery replay, modeled failures, and developer documentation.

**Architecture:** Extend the existing SQLite stores and migration setup, service handlers, simulator, event bus, admin API, and Preact inbox. Keep AWS serialization at the Smithy service boundary, simulation controls in the admin API, and external publishing behind the existing sink interface. Persist stable lifecycle identifiers and delivery attempts so process restarts do not lose behavior.

**Tech Stack:** TypeScript, Node.js 24 built-in SQLite, Fastify, AWS SDK v3 SNS client, Preact/Vite, Bun scripts.

**Spec:** `docs/specs/2026-10-09-generic-emulator-completeness-design.md`

## Global Constraints

- Preserve AWS field casing and the vendored AWS Smithy request/response model.
- Preserve the nine currently supported AWS Social Messaging operations and existing seeded resources.
- Keep the AWS message ID and Meta WAMID independently representable.
- Keep `whatsAppWebhookEntry` as a JSON string containing one `{id, changes}` entry.
- Keep application policy, identity, namespace, bindings, readiness, and deployment assumptions out of the emulator.
- Keep existing database files readable through forward-only migrations and defaults.
- Do not claim AWS/Meta delivery or production suitability.
- Do not publish or push changes as part of implementation; this plan covers local source changes only.
- Do not run the test suite unless the user explicitly requests test/verification execution.

## Review Focus

- Old SQLite databases without lifecycle columns must open and preserve their existing rows.
- Two template updates at the same clock millisecond must still have distinct generations.
- A delayed approval/rejection must not alter a later template definition.
- A quoted reply must reject a WAMID belonging to a different phone number or customer.
- Replaying one failed destination must preserve the original event ID and bytes and must not create another outbound message.

## File Map

- `src/store/db.ts`: schema creation and safe forward migrations for template generations and definition JSON.
- `src/store/types.ts`: persisted message, template, event, and attempt types.
- `src/store/messages.ts`: callback data, reply context, AWS/Meta IDs, lookup and status history.
- `src/store/templates.ts`: definition generations and conditional status transitions.
- `src/store/events.ts`: destination attempt history, replay selection, and durable updates.
- `src/services/socialmessaging/send.ts`: outbound payload preservation and AWS-compatible validation.
- `src/services/socialmessaging/templates.ts`: lossless definition create/update/get/list behavior.
- `src/domain/templates.ts`, `src/domain/render.ts`: component-aware parameter validation and preview rendering.
- `src/events/envelope.ts`: status callback and inbound interaction payloads.
- `src/events/bus.ts`, `src/events/sinks.ts`: persisted publish results and targeted event replay.
- `src/sim/simulator.ts`: generation-safe decisions, supported inbound messages, and event timing.
- `src/api/admin.ts`: generic admin reply, template state, and event replay endpoints.
- `ui/src/api.ts`, `ui/src/Thread.tsx`, `ui/src/Templates.tsx`, `ui/src/Inspector.tsx`: inbox controls and display.
- `ui/src/styles.css`: minimal styles for interaction and event-attempt controls.
- `README.md`, `eum-social-local-emulator.example.yaml`: runnable generic examples and configuration explanation.
- Existing tests under `test/` are useful coverage references, but test files and test execution are excluded by the current instruction not to add/run tests unless requested.

## Implementation Tasks

### Task 1: Persist message correlation and support generic inbound interactions

**Files:**
- Modify: `src/store/types.ts`, `src/store/messages.ts`
- Modify: `src/services/socialmessaging/send.ts`, `src/domain/render.ts`
- Modify: `src/events/envelope.ts`, `src/sim/simulator.ts`, `src/api/admin.ts`
- Modify: `ui/src/api.ts`, `ui/src/Thread.tsx`, `ui/src/Inspector.tsx`

**Interfaces:**
- Outbound rows retain the original message JSON, including `biz_opaque_callback_data`, plus separate `wamid` and `awsMessageId` values.
- Admin inbound requests accept text/image and native `button`, `interactive.button_reply`, or `interactive.list_reply` data, with optional `contextMessageId` and optional customer name.
- The simulator validates quoted message ownership against phone ID and normalized peer before creating a new inbound WAMID.
- Status webhook objects include callback data from the corresponding outbound message.

- [x] Use the existing persisted raw message JSON as the source of callback and context data; no duplicate message columns are needed.
- [x] Preserve the opaque callback value without coercing its type or changing the outbound JSON.
- [x] Build inbound payloads with separate display and payload/ID fields for each supported button/list form.
- [x] Include `context.id` only when supplied and reject cross-phone or cross-peer references.
- [x] Add inbox controls to quote a selected outbound message and submit a text or supported interaction.
- [x] Show the independent AWS and Meta identifiers and callback data in message inspection.
- [x] Inspect the resulting diff and type-level consistency; do not run tests unless requested.

### Task 2: Make template definitions lossless and lifecycle decisions generation-safe

**Files:**
- Modify: `src/store/db.ts`, `src/store/types.ts`, `src/store/templates.ts`
- Modify: `src/services/socialmessaging/templates.ts`
- Modify: `src/domain/templates.ts`, `src/domain/render.ts`
- Modify: `src/sim/simulator.ts`, `src/api/admin.ts`
- Modify: `ui/src/api.ts`, `ui/src/Templates.tsx`, `ui/src/styles.css`

**Interfaces:**
- `TemplateRow` carries an integer `generation`, initialized for existing rows during migration.
- Create/update stores the provider definition fields and component JSON as submitted; get/list returns supported AWS fields without content rewriting.
- Scheduled and manual decisions specify the generation they target; stale generations return a conflict/no-op and cannot mutate the current template.
- Admin state controls support `APPROVED`, `REJECTED`, `PAUSED`, and `DISABLED`, with rejection reason retained for inspection.

- [x] Add a generation column and migrate existing templates to generation 1.
- [x] Increment generation on every update independently of timestamps; schedule approval against the captured generation.
- [x] Make template status updates conditional on the requested current generation.
- [x] Preserve definition fields, including examples and parameter format, while retaining AWS response casing and blob serialization.
- [x] Render and validate text HEADER, BODY, FOOTER, dynamic URL BUTTONS, and supported AUTHENTICATION components.
- [x] Add inbox preview rendering and manual PAUSED/DISABLED controls, exposing rejection details.
- [x] Ensure sends are allowed only for the current generation when its state is APPROVED.
- [x] Inspect changed code and stored type consistency; do not run tests unless requested.

### Task 3: Persist event destination attempts and add targeted replay

**Files:**
- Modify: `src/store/db.ts`, `src/store/types.ts`, `src/store/events.ts`
- Modify: `src/events/bus.ts`, `src/events/sinks.ts`
- Modify: `src/api/admin.ts`
- Modify: `ui/src/api.ts`, `ui/src/Inspector.tsx`, `ui/src/Events.tsx`, `ui/src/styles.css`

**Interfaces:**
- An event remains a single immutable envelope with one provider event ID and exact serialized payload.
- Destination delivery attempts are persisted with attempt time, result, and detail; each replay targets a failed destination and appends an attempt.
- Admin replay accepts an event ID and destination identifier; it never calls the outbound send path.

- [x] Migrate existing delivery arrays into a durable attempt representation or extend their representation compatibly.
- [x] Keep the original envelope and ID immutable across retry; append each retry outcome.
- [x] Implement per-destination replay using the existing SNS/webhook sink configuration and surface unsupported destinations as explicit failures.
- [x] Keep SNS `Message` content equal to the EUM envelope serialization expected by the AWS event integration.
- [x] Add inbox replay controls and attempt history for failed destinations.
- [x] Inspect retry scope, immutable event fields, and restart behavior in the code; do not run tests unless requested.

### Task 4: Complete modeled error behavior, package docs, and release-facing walkthrough

**Files:**
- Modify: `src/services/socialmessaging/send.ts`, `src/domain/templates.ts`, `src/smithy/errors.ts` only where current modeled shapes require it
- Modify: `src/api/aws.ts` only if support coverage is inaccurate
- Modify: `README.md`, `eum-social-local-emulator.example.yaml`, and example source files if needed
- Modify: `package.json` only if package contents omit required runtime assets

**Interfaces:**
- Every advertised supported operation performs its documented local effect; unsupported modeled operations return the existing modeled 501 behavior.
- Immediate invalid/denied/throttled/missing/incomplete-registration cases use modeled AWS exceptions; accepted asynchronous failures remain status events.
- Documentation contains a generic official AWS SDK walkthrough: discover, create, approve, send, inspect status, and correlated reply.

- [x] Reconcile the Smithy error model and current handlers for denied, throttled, missing-resource, incomplete-registration, invalid-template, and invalid-parameter cases.
- [x] Ensure synchronous request failures and asynchronous simulated delivery failures remain separate paths.
- [x] Add an example that uses the official SDK endpoint override and admin payloads without application-specific IDs or policies.
- [x] Document multiple WABAs/numbers, external LocalStack/SNS setup, database restart persistence, component support, and unsupported operations.
- [x] Verify the package allowlist includes built UI assets and example configuration through source inspection; do not publish or run tests unless separately requested.
- [x] Review the final diff for KAI-specific names/policies and report any unverified compatibility claims.

## Dependency Order

1. Task 1 establishes message identifiers and interaction payload contracts.
2. Task 2 establishes independent template definition generations and state controls.
3. Task 3 can be developed alongside Task 2 after the DB migration conventions are confirmed, but final UI integration should follow its event-attempt API.
4. Task 4 documents and reconciles behavior after Tasks 1–3 are implemented.

## Completion Report

Report changed files, implemented acceptance criteria, any behavior left outside scope, and whether verification was run. Do not claim test or SDK compatibility success without executing the corresponding checks.
