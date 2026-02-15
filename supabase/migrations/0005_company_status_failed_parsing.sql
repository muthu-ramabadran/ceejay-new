-- Allow scraper fail-fast runs to persist status = 'failed_parsing'

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- Remove any existing status check constraint on companies.status.
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'companies'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE public.companies
ADD CONSTRAINT companies_status_check
CHECK (status IN ('startup', 'acquired', 'closed', 'ipoed', 'failed_parsing'));
