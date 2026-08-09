-- ============================================================================
-- Migración: RAM / almacenamiento / procesador en productos (equipos)
-- Ejecutar una sola vez en el SQL editor de Supabase (producción ya tiene
-- datos, por eso no se puede simplemente re-correr schema.sql completo).
-- ============================================================================

ALTER TABLE productos ADD COLUMN IF NOT EXISTS ram text;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS almacenamiento text;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS procesador text;
