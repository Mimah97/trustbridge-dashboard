# Registration Data Retention

This document describes how TrustBridge Dashboard handles registration payloads,
including validation, storage, and retention of the fields collected during the
registration flow (`src/app/register/RegisterClient.tsx` → `src/app/api/register/route.ts`).

## Registration payload fields

Registration requests are validated against shared Zod schemas defined in
`src/lib/` so that the API route and the client form enforce identical rules.
The validated fields are:

| Field           | Validation summary                                              |
| --------------- | -------------------------------------------------------------- |
| `email`         | Required, trimmed, lowercased, valid email format, max length. |
| `username`      | Required, trimmed, allowed characters, min/max length.         |
| `walletAddress` | Required, trimmed, expected address format.                    |
| `inviteCode`    | Optional, trimmed, expected format when provided.              |

Invalid payloads are rejected by the API with a `400` response containing
field-level error messages. Auth, CSRF, and rate-limit gates run before payload
validation and are unaffected by these checks.

## Retention

- Registration payloads are retained only as long as needed to provision the
  account and satisfy audit requirements.
- Rejected (invalid) payloads are not persisted; validation errors are returned
  to the caller and not stored.
- Operators should not log raw payload contents (email, wallet address, invite
  code) outside of the standard structured error reporting.

## Operator notes

- Validation rules live in the shared schemas under `src/lib/`; update them in
  one place to keep the API and client consistent.
- If a new registration field is added, extend the shared schema and update the
  table above so retention expectations remain documented.
