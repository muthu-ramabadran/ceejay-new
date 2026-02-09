ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS total_raised_amount BIGINT,
  ADD COLUMN IF NOT EXISTS total_raised_currency_code TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_total_raised_amount
  ON companies(total_raised_amount);
