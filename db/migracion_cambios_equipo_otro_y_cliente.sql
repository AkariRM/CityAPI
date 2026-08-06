-- ============================================================================
-- Migración incremental: condición "Otro" + cliente_id en cambios_equipo
--
-- Solo corre esto si YA habías ejecutado migracion_cambios_equipo_y_ordenes_compra.sql
-- anteriormente (es decir, la tabla cambios_equipo ya existe). Si todavía no
-- corres esa migración base, ignora este archivo: ya está incluido dentro de
-- migracion_cambios_equipo_y_ordenes_compra.sql actualizado.
-- ============================================================================

ALTER TYPE grado_cambio_equipo ADD VALUE IF NOT EXISTS 'otro';
ALTER TABLE cambios_equipo ADD COLUMN IF NOT EXISTS grado_detalle text;
ALTER TABLE cambios_equipo ADD COLUMN IF NOT EXISTS cliente_id uuid REFERENCES clientes(id);
