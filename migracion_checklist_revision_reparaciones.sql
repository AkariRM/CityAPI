ALTER TABLE reparaciones
  ADD COLUMN IF NOT EXISTS checklist_revision jsonb;
