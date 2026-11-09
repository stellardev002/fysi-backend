-- Audit log is append-only: admin actions must stay reviewable (PRD: admin access).
CREATE FUNCTION audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();--> statement-breakpoint
-- Supabase publishes the public schema through its Data API (PostgREST) to the
-- `anon` and `authenticated` roles, whose key ships in browsers. This API is the
-- only way in: RLS on with no policies denies those roles every row, and the
-- revokes remove their table access outright. The backend connects as the table
-- owner, which RLS does not apply to (no FORCE). New tables get RLS from
-- `.enableRLS()` on their pgTable; test/database.e2e-spec.ts checks every table.
-- The roles exist only on Supabase; plain Postgres (CI, local) skips this.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- Launch categories (PRD overview). Admins rename, reorder or add more later.
INSERT INTO categories (id, name, slug, sort_order) VALUES
  (gen_random_uuid(), 'Clothing', 'clothing', 10),
  (gen_random_uuid(), 'Household items', 'household', 20),
  (gen_random_uuid(), 'Beauty and personal care', 'beauty-personal-care', 30),
  (gen_random_uuid(), 'Eco-friendly gadgets', 'gadgets', 40),
  (gen_random_uuid(), 'Office supplies', 'office-supplies', 50),
  (gen_random_uuid(), 'Outdoor and travel', 'outdoor-travel', 60)
ON CONFLICT DO NOTHING;
