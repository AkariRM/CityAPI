-- CityPhone SGI — migraciones pendientes juntas (08-oct-2026) — IDEMPOTENTE
--
-- Pegar y ejecutar completo en el SQL Editor de Supabase. Se puede repetir sin problema: cada sentencia revisa si ya existe.
-- No usa BEGIN/COMMIT (el editor corre cada sentencia por separado) ni tablas temporales.
--
-- Trae dos migraciones:
--   1. Flujo de reparaciones por fases: la cotizacion aproximada que se captura al recibir el equipo.
--   2. Revision de costos: lo que se guarda al revisar un folio entregado (cobrado, mano de obra, piezas, utilidad), el
--      precio de cada pieza cobrada al cliente y la ganancia opcional sobre piezas en Configuracion (apagada por defecto).
--
-- Orden de publicacion: este archivo -> Render (Manual Deploy de CityAPI) -> dist (CityApp).

-- ============================================================================
-- 1. Flujo de reparaciones por fases
-- ============================================================================

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS cotizacion_aproximada numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reparaciones_cotizacion_aproximada_check') THEN
    ALTER TABLE reparaciones ADD CONSTRAINT reparaciones_cotizacion_aproximada_check CHECK (cotizacion_aproximada >= 0);
  END IF;
END $$;

-- ============================================================================
-- 2. Revision de costos y ganancia opcional sobre piezas
-- ============================================================================

ALTER TABLE reparaciones
  ADD COLUMN IF NOT EXISTS costos_revisados_at timestamptz,
  ADD COLUMN IF NOT EXISTS costos_revisados_por uuid REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS revision_entregado_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision_reparacion numeric(12,2),
  ADD COLUMN IF NOT EXISTS revision_mano_obra numeric(12,2) CHECK (revision_mano_obra >= 0),
  ADD COLUMN IF NOT EXISTS revision_costo_piezas numeric(12,2) CHECK (revision_costo_piezas >= 0),
  ADD COLUMN IF NOT EXISTS revision_utilidad numeric(12,2);

CREATE INDEX IF NOT EXISTS idx_reparaciones_costos_pendientes ON reparaciones(created_at) WHERE estado = 'entregado' AND costos_revisados_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reparaciones_costos_revisados ON reparaciones(revision_entregado_at) WHERE costos_revisados_at IS NOT NULL;

ALTER TABLE reparacion_refacciones ADD COLUMN IF NOT EXISTS precio numeric(12,2) CHECK (precio >= 0);

ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS reparacion_margen_piezas_activo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reparacion_margen_piezas_pct numeric(6,2) NOT NULL DEFAULT 30 CHECK (reparacion_margen_piezas_pct >= 0 AND reparacion_margen_piezas_pct <= 1000);

-- ============================================================================
-- Comprobacion: deben salir 10 filas (cotizacion aproximada, 7 de la revision, el precio de las piezas y 2 de la configuracion)
-- ============================================================================

SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'reparaciones' AND column_name IN ('cotizacion_aproximada', 'costos_revisados_at', 'costos_revisados_por', 'revision_entregado_at', 'revision_reparacion', 'revision_mano_obra', 'revision_costo_piezas', 'revision_utilidad'))
   OR (table_name = 'reparacion_refacciones' AND column_name = 'precio')
   OR (table_name = 'configuracion_ticket' AND column_name IN ('reparacion_margen_piezas_activo', 'reparacion_margen_piezas_pct'))
ORDER BY table_name, column_name;
