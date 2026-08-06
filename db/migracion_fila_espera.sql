-- ============================================================================
-- Migración: Fila de espera (mostrador)
-- Ejecutar una sola vez en el SQL editor de Supabase (producción ya tiene datos,
-- por eso no se puede simplemente re-correr schema.sql completo).
-- ============================================================================

CREATE TABLE fila_espera (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  nombre        text NOT NULL,
  motivo        text,
  atendido      boolean NOT NULL DEFAULT false,
  atendido_por  uuid REFERENCES usuarios(id),
  atendido_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fila_espera_sucursal ON fila_espera(sucursal_id, atendido);
