-- ============================================================================
-- Migración: editar/dar de baja equipos, dar de baja unidades IMEI, e IMEI
-- opcional (por equipo y por unidad).
-- Ejecutar una sola vez en el SQL editor de Supabase (producción ya tiene
-- datos, por eso no se puede simplemente re-correr schema.sql completo).
-- ============================================================================

ALTER TABLE productos ADD COLUMN IF NOT EXISTS usa_imei boolean NOT NULL DEFAULT true;
ALTER TABLE unidades_imei ALTER COLUMN imei DROP NOT NULL;
