# Native Document Header Implementation Plan

> **For agentic workers:** Implement task-by-task with a test-first cycle; preserve existing local observability work in the main worktree.

**Goal:** Validate and simulate AWS EUM WhatsApp template document headers end to end, from approval sample and phone-owned runtime media through inbox download and message inspection.

**Architecture:** Add a shared media policy module for MIME compatibility and decimal byte limits, validate approval handles while creating/updating templates, and validate runtime header parameters before enqueueing a send. Keep media bytes in the existing SQLite store; expose metadata and download endpoints used by the inbox card and inspector. Preserve AWS SDK request shapes, current message/event lifecycle, and all unrelated dirty work.

**Tech Stack:** TypeScript, Bun, Fastify, SQLite, Vitest, AWS SDK for JavaScript v3, React.

**Spec:** `/Users/gyankumar/Works/kai-backend/docs/superpowers/specs/2026-10-12-eum-local-emulator-document-header-requirements.md`

## Global Constraints

- AWS media limits use decimal MB/KB exactly as documented.
- Approval sample handles are WABA-owned; runtime media IDs are phone-owned.
- KAI's 20 MiB aggregate / 20-file application limit is not implemented in the emulator.
- Only local simulation is claimed; no real Meta approval or delivery is implied.
- Keep existing trace changes and user work intact; do not commit or publish.

## Review Focus

- Wrong WABA sample handle or runtime media from another phone must fail closed.
- Approval sample handle cannot be reused as a runtime media ID.
- Deleted/missing media must be explicit in the inbox and never replaced by sample bytes.
- Missing, duplicate, or wrong-type header parameters must not create delivered/read events.
- Long filenames and document downloads must retain accessible controls and exact bytes.

---

### Task 1: Shared supported media policy

**Files:** Create `src/domain/media.ts`; modify `src/services/socialmessaging/media.ts` and `src/services/socialmessaging/templates.ts`; test `test/domain/media.test.ts` and `test/api/media.test.ts`.

**Interfaces:** Export `mediaLimitBytes(mimeType: string): number | undefined`, `validateMediaUpload(mimeType: string, bytes: Uint8Array): string | null`, `isMimeCompatibleWithHeader(format: string, mimeType: string): boolean`, and `isSupportedDocumentMime(mimeType: string): boolean`.

- [x] Write tests for accepted/rejected MIME families, empty bytes, exact boundary and one byte over each configured category limit.
- [x] Run the focused tests and confirm the new assertions fail.
- [x] Implement a documented MIME map and decimal limits: documents 100,000,000 bytes; images 5,000,000; audio/video 16,000,000; static WebP stickers 100,000 and animated WebP 500,000 where classification is available.
- [x] Apply actual-byte validation to both template sample and runtime uploads and source-presigned uploads.
- [x] Rerun focused media tests.

### Task 2: Approval sample validation and template generation safety

**Files:** Modify `src/services/socialmessaging/templates.ts`; test `test/api/templates.test.ts`.

**Interfaces:** Add one validator that accepts `(ctx, waba, components)` and rejects malformed/conflicting headers or missing, unknown, deleted, cross-WABA, unsupported, or MIME-incompatible `example.header_handle` values for DOCUMENT headers.

- [x] Add AWS SDK tests for valid PDF sample creation; missing and duplicate headers; missing/unknown/deleted sample; cross-WABA sample; wrong MIME; and update rejection that does not increment generation or replace components.
- [x] Run the focused template tests and verify failures.
- [x] Validate create and update before persistence/scheduling; preserve current pending/generation behavior on valid updates.
- [x] Rerun template tests, including stale-generation approval coverage.

### Task 3: Runtime send validation and trace metadata

**Files:** Modify `src/domain/templates.ts`, `src/services/socialmessaging/send.ts`, `src/store/types.ts`; tests `test/domain/templates.test.ts` and `test/api/send.test.ts`.

**Interfaces:** Export a document-header resolver that validates component cardinality and document parameter shape, then resolves the phone-owned media row and returns `{ media, filename }`; malformed/unauthorized inputs throw AWS-compatible `InvalidParametersException` or `ResourceNotFoundException` as appropriate. Trace metadata records template name/language/generation and media ID, filename, MIME, size, SHA-256, and validation result.

- [x] Add test-first coverage for missing/duplicate header, wrong parameter type, missing ID, unknown/deleted ID, cross-phone ID, sample handle, wrong MIME, and no delivered/read status after rejection.
- [x] Verify failures before writing implementation.
- [x] Validate approved lifecycle and runtime media before inserting/scheduling the message; sanitize filenames and use a safe fallback.
- [x] Preserve body, URL button, service-window, simulator and event behavior.
- [x] Rerun focused domain and SDK send tests, including approved template outside 24h and free-form text inside/outside the window.

### Task 4: Inbox document card and exact-byte download

**Files:** Modify `src/api/admin.ts`, `ui/src/api.ts`, `ui/src/TemplatePreview.tsx`, `ui/src/Thread.tsx`, `ui/src/styles.css`; tests `test/api/admin.test.ts` and UI tests if an existing UI harness is present.

**Interfaces:** Add metadata response `{ mediaId, mimeType, size, sha256, available }`; preserve `GET /_eum/api/media/:id` raw-byte behavior; add a download endpoint that returns the stored bytes with a safe `Content-Disposition` filename.

- [x] Add API tests for metadata, exact-byte download/hash, missing/deleted media, safe filename disposition, and existing image route compatibility.
- [x] Verify the tests fail before adding endpoints/UI.
- [x] Render the actual send-time document parameter as a responsive card with filename, MIME, size, and accessible download link; show explicit unavailable state.
- [x] Keep document with body/footer/two safe URL preview buttons; no sample substitution.
- [x] Verify narrow viewport and keyboard reachability using available UI tooling.

### Task 5: Inspector, docs, and SDK acceptance flow

**Files:** Modify `ui/src/Inspector.tsx`, `ui/src/api.ts`, `README.md`; tests `test/api/send.test.ts`, `test/api/admin.test.ts`, and existing UI tests.

- [x] Add an SDK-level end-to-end test: upload approval PDF, create/approve template, upload a different runtime PDF, send with body/footer/two URL buttons, inspect/download exact bytes, advance status events, and simulate a quoted reply retaining `context.id`.
- [x] Verify restart persistence with a temporary file-backed database where the test harness permits it.
- [x] Expose template/media fields and unavailable/resolution state in the inspector while retaining existing raw request/event history.
- [x] Document supported MIME/size table, errors, sample/runtime ID distinction, and simulation limits, citing AWS documentation.
- [x] Run the full suite and production build/typecheck; report any environment-dependent UI or restart coverage limits.
