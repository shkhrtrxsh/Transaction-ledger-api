# Transaction Ledger API

A standalone Node.js, TypeScript, Express, and PostgreSQL API for accounts,
credits, debits, and atomic money transfers.

The ledger is append-only. Balances are changed only through the service layer in
the same database transaction as their ledger entries, and database triggers
reject updates and deletes to ledger and transfer records.

## Requirements

- Node.js 20 or newer (verified with Node.js 24)
- npm 11 or newer
- Docker (for the PostgreSQL container)

## Setup

```bash
docker compose up -d
cp .env.example .env
npm install
npm run migrate
npm run dev
```

The API listens on `http://localhost:3000` by default. PostgreSQL is exposed on
`localhost:5432` with the credentials in `docker-compose.yml`.

To run the compiled application:

```bash
npm run build
npm start
```

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `DATABASE_URL` | PostgreSQL connection for the API and migrations | `postgres://postgres:postgres@localhost:5432/transaction_ledger` |
| `TEST_DATABASE_URL` | Dedicated integration-test database | `postgres://postgres:postgres@localhost:5432/transaction_ledger_test` |
| `DB_POOL_MAX` | PostgreSQL pool size | `10` |

See `.env.example`.

## Migrations

Migrations are plain SQL files in `migrations/`, applied in filename order by:

```bash
npm run migrate
```

The runner records applied files in `schema_migrations`, uses an advisory lock to
avoid concurrent runs, and wraps each migration in a transaction.

The integration suite creates `TEST_DATABASE_URL` automatically when missing and
applies all migrations before the tests run.

## Tests

```bash
npm test
npm run typecheck
```

The suite uses Vitest and Supertest against a dedicated PostgreSQL database. Test
files run sequentially because they share that database; each test starts with
`TRUNCATE transactions, transfers, accounts`.

Coverage includes:

- exact decimal credits/debits and insufficient-funds behavior
- duplicate references, including concurrent duplicate submissions
- concurrent debits and transfers under row locks
- opposite-direction transfers without deadlocks
- transaction/transfer serialization on the same account
- rollback when a test-only trigger forces a ledger insert failure
- destination balance overflow
- history filtering, pagination, ordering, and empty pages
- immutable ledger/transfer records and restrictive account foreign keys

Run `docker compose up -d` before the suite. The test database is created through
the `postgres` maintenance database, so the configured user needs `CREATEDB`.

## API

Full request/response/error documentation is in [`openapi.yaml`](./openapi.yaml).

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/accounts` | Create an account with balance `"0.00"` |
| `POST` | `/accounts/:accountId/transactions` | Create a credit or debit |
| `GET` | `/accounts/:accountId/balance` | Read an account balance |
| `GET` | `/accounts/:accountId/transactions` | Read filtered, paginated history |
| `POST` | `/transfers` | Atomically debit one account and credit another |

### Examples

Create an account:

```bash
curl -sS http://localhost:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Example"}'
```

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Alice Example",
  "balance": "0.00",
  "created_at": "2026-10-27T12:00:00.000Z"
}
```

Credit an account:

```bash
curl -sS http://localhost:3000/accounts/ACCOUNT_ID/transactions \
  -H 'Content-Type: application/json' \
  -d '{"type":"credit","amount":"100.50","reference_id":"credit-001"}'
```

```json
{
  "transaction": {
    "id": "22222222-2222-4222-8222-222222222222",
    "account_id": "11111111-1111-4111-8111-111111111111",
    "type": "credit",
    "amount": "100.50",
    "description": "",
    "reference_id": "credit-001",
    "transfer_id": null,
    "created_at": "2026-10-27T12:01:00.000Z"
  },
  "balance": "100.50"
}
```

Transfer money:

```bash
curl -sS http://localhost:3000/transfers \
  -H 'Content-Type: application/json' \
  -d '{
    "source_account_id":"SOURCE_ID",
    "destination_account_id":"DESTINATION_ID",
    "amount":"30.25",
    "reference_id":"rent-2026-10",
    "description":"Monthly rent"
  }'
```

```json
{
  "transfer_id": "44444444-4444-4444-8444-444444444444",
  "source_transaction_id": "33333333-3333-4333-8333-333333333333",
  "destination_transaction_id": "66666666-6666-4666-8666-666666666666",
  "source_balance": "69.75",
  "destination_balance": "30.25",
  "amount": "30.25",
  "reference_id": "rent-2026-10",
  "description": "Monthly rent",
  "created_at": "2026-10-27T12:02:00.000Z"
}
```

List history:

```bash
curl -sS 'http://localhost:3000/accounts/ACCOUNT_ID/transactions?type=debit&page=1&limit=20'
```

```json
{
  "account_id": "11111111-1111-4111-8111-111111111111",
  "transactions": [],
  "pagination": {
    "current_page": 1,
    "page_size": 20,
    "total_records": 0,
    "total_pages": 0
  }
}
```

## Validation and errors

Errors always use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {}
  }
}
```

| HTTP status | Codes |
| --- | --- |
| `400` | `VALIDATION_ERROR`, `INVALID_JSON` |
| `404` | `ACCOUNT_NOT_FOUND`, `NOT_FOUND` |
| `409` | `DUPLICATE_REFERENCE`, `INSUFFICIENT_FUNDS`, `BALANCE_LIMIT_EXCEEDED` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `500` | `INTERNAL_ERROR` |

- Request bodies reject unknown fields, including client-supplied IDs, balances,
  and timestamps.
- Names and reference IDs are trimmed, must be nonempty, and are capped at 200
  characters. Descriptions default to `""` and are capped at 1,000 characters.
- Amounts are positive decimal strings with at most two decimal places and a
  maximum of `9999999999999999.99`.
- Money is returned as strings and all arithmetic is performed with PostgreSQL
  `NUMERIC(18,2)`, never JavaScript floating point.
- History is ordered by `created_at DESC, id DESC`. `page` defaults to `1`,
  `limit` defaults to `20`, and `limit` is capped at `100`.
- A page beyond the available results returns an empty `transactions` array with
  complete pagination metadata.

## Atomicity and concurrency

### Ordinary transactions

1. Begin a database transaction.
2. Lock the account row with `SELECT ... FOR UPDATE`; return `404` if absent.
3. Check the account/reference duplicate before funds; return `409` if present.
4. Apply the balance change with PostgreSQL decimal arithmetic in a guarded
   `UPDATE`, then insert the ledger entry.
5. Commit, or roll back every change on error. The client is released in
   `finally`.

The account row lock serializes concurrent changes. The unique constraint on
`(account_id, reference_id)` is the final duplicate safeguard.

### Transfers

1. Validate the body and reject identical source/destination accounts.
2. Begin one database transaction and lock both accounts in ascending UUID order;
   this ordering is used by every transfer to prevent deadlocks.
3. Verify both accounts exist. Check the globally unique transfer reference before
   checking funds.
4. Check source funds and destination balance capacity with PostgreSQL decimal
   arithmetic.
5. Insert the transfer, update both balances, and insert one debit and one credit
   with the generated reference `transfer:<transfer UUID>`.
6. Commit all five changes together, or roll back all of them.

Transfer entries share a `transfer_id` and appear in normal account history.
Ordinary entries return `transfer_id: null`. Ordinary transaction references
beginning with `transfer:` are rejected so they cannot collide with generated
transfer references.

### Database integrity

- `accounts.balance` is `NUMERIC(18,2)`, defaults to zero, and cannot be negative.
- Transaction amounts are positive `NUMERIC(18,2)` values with a constrained
  `credit`/`debit` type.
- Transfers have distinct source/destination accounts and a globally unique
  reference ID.
- `transactions` has a unique `(account_id, reference_id)` constraint and a
  history index on `(account_id, created_at DESC, id DESC)`.
- A partial unique index on `(transfer_id, type)` prevents duplicate debit or
  credit entries for one transfer.
- Triggers reject updates and deletes on `transactions` and `transfers`.
- Foreign keys use `ON DELETE RESTRICT`, so referenced accounts cannot be deleted.

## Assumptions

- One implicit currency with two decimal places. No authentication, UI,
  deployment configuration, currency conversion, or transfer listing/detail
  endpoints are included.
- Ordinary transaction references are unique per account. Transfer references
  are globally unique; this is an implementation assumption because the assessment
  does not define transfer retry behavior.
- Duplicate submissions return `409`, even when the retry payload is identical.
- A successful transfer preserves the combined balance of the two accounts.
- Timestamps are generated by PostgreSQL and returned as UTC ISO-8601 strings.
- There are no update or delete APIs for ledger entries or transfers.

## Project layout

```text
migrations/               SQL schema and integrity rules
src/
  db/                     pool, migration runner, transaction helpers
  domain/                 money constants and exact-string helpers
  errors/                 application and database error helpers
  middleware/             centralized error handling
  routes/                 Express route definitions
  services/               account, transaction, and transfer logic
  validation/             Zod schemas and request parsing
  app.ts                  Express application
  index.ts                HTTP server and graceful shutdown
tests/                    Vitest + Supertest integration tests
openapi.yaml              OpenAPI 3.1 document
docker-compose.yml        PostgreSQL 16
```
