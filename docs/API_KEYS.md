# API Keys

TrustBridge API keys authenticate machine-to-machine requests to the
`src/app/api/` routes. This document describes how API-key auth interacts with
session auth, and the explicit matrix of allowed credential combinations that
routes accepting either credential must enforce.

## Credential sources

- **Session** — resolved by `src/lib/api-auth.ts` from the request cookies.
- **API key** — resolved by `src/lib/api-key-auth.ts` from the
  `Authorization: Bearer <key>` header (or the configured key header).

Both helpers return a stable result shape so call sites in `src/app/api/` can
branch on the outcome without inventing a parallel auth subsystem.

## Dual-auth matrix

Routes that accept *either* a session or an API key must follow this matrix.
"Present" means the credential was supplied on the request; "valid" means it
resolved to an active principal.

| Session | API key | Outcome |
| ------- | ------- | ------- |
| absent  | absent  | `401` — `missing_credentials` |
| valid   | absent  | allow — session principal |
| absent  | valid   | allow — API-key principal |
| valid   | valid   | allow — session principal wins; API key is ignored |
| invalid | absent  | `401` — `invalid_session` |
| absent  | invalid | `401` — `invalid_api_key` |
| invalid | valid   | allow — API-key principal |
| valid   | invalid | allow — session principal |
| invalid | invalid | `401` — `invalid_credentials` |

Rules:

1. A single valid credential is always sufficient (happy path).
2. When both credentials are present and valid, the session principal is used
   and the API key is not consulted for authorization decisions.
3. An invalid credential never overrides a valid one; the valid credential wins.
4. When no valid credential is present, the route fails closed with a stable
   error code from the table above.

## Error responses

Failures return a JSON body with a stable `error` code and a human-readable
`message`. Codes are stable so clients and tests can assert on them:

- `missing_credentials` — neither credential supplied.
- `invalid_session` — session supplied but not valid.
- `invalid_api_key` — API key supplied but not valid.
- `invalid_credentials` — both supplied but neither valid.

## Tests

`tests/` covers the matrix above, including the happy path (valid single
credential) and failure paths (missing credentials, invalid credentials, and
conflicting dual credentials). When adding a route that accepts session or API
key auth, extend the matrix tests rather than adding ad-hoc assertions.

## Security notes

- API keys are never logged or echoed back in responses.
- Only a masked prefix of a key may appear in operator-facing output.
- Existing pause and happy-path semantics are preserved; this matrix only
defines which credential is honored when multiple are present.
