CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  balance NUMERIC(18, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_name_valid
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT accounts_balance_nonnegative CHECK (balance >= 0)
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id UUID NOT NULL,
  destination_account_id UUID NOT NULL,
  amount NUMERIC(18, 2) NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfers_source_account_fk
    FOREIGN KEY (source_account_id) REFERENCES accounts (id) ON DELETE RESTRICT,
  CONSTRAINT transfers_destination_account_fk
    FOREIGN KEY (destination_account_id) REFERENCES accounts (id) ON DELETE RESTRICT,
  CONSTRAINT transfers_reference_id_key UNIQUE (reference_id),
  CONSTRAINT transfers_amount_positive CHECK (amount > 0),
  CONSTRAINT transfers_reference_id_valid
    CHECK (
      reference_id = btrim(reference_id)
      AND char_length(reference_id) BETWEEN 1 AND 200
    ),
  CONSTRAINT transfers_description_length CHECK (char_length(description) <= 1000),
  CONSTRAINT transfers_distinct_accounts
    CHECK (source_account_id <> destination_account_id)
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  type TEXT NOT NULL,
  amount NUMERIC(18, 2) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL,
  transfer_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transactions_account_fk
    FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE RESTRICT,
  CONSTRAINT transactions_transfer_fk
    FOREIGN KEY (transfer_id) REFERENCES transfers (id) ON DELETE RESTRICT,
  CONSTRAINT transactions_type_valid CHECK (type IN ('credit', 'debit')),
  CONSTRAINT transactions_amount_positive CHECK (amount > 0),
  CONSTRAINT transactions_reference_id_valid
    CHECK (
      reference_id = btrim(reference_id)
      AND char_length(reference_id) BETWEEN 1 AND 200
    ),
  CONSTRAINT transactions_description_length CHECK (char_length(description) <= 1000),
  CONSTRAINT transactions_account_reference_key UNIQUE (account_id, reference_id)
);

CREATE INDEX transactions_account_history_idx
  ON transactions (account_id, created_at DESC, id DESC);

-- A transfer contributes exactly one debit and one credit, each linked to the
-- same transfer. This index makes duplicates impossible even under races.
CREATE UNIQUE INDEX transactions_transfer_type_unique_idx
  ON transactions (transfer_id, type)
  WHERE transfer_id IS NOT NULL;

CREATE FUNCTION reject_ledger_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger records are immutable'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER transactions_reject_update
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION reject_ledger_modification();

CREATE TRIGGER transactions_reject_delete
  BEFORE DELETE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION reject_ledger_modification();

CREATE TRIGGER transfers_reject_update
  BEFORE UPDATE ON transfers
  FOR EACH ROW
  EXECUTE FUNCTION reject_ledger_modification();

CREATE TRIGGER transfers_reject_delete
  BEFORE DELETE ON transfers
  FOR EACH ROW
  EXECUTE FUNCTION reject_ledger_modification();
