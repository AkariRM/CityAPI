-- Revision de costos de reparaciones + ganancia opcional sobre piezas — idempotente.
--
-- Revision de costos: cuando un folio queda Entregado entra a la lista "Revision de costos". Ahi el dueño o el
-- supervisor capturan la mano de obra que se le paga al tecnico por ese folio y confirman el costo real de las piezas.
-- Utilidad = lo cobrado - mano de obra - costo de piezas. Al marcarlo como revisado el folio sale de esa lista y pasa
-- a la lista de utilidad mensual (por mes de entrega). Se guarda una foto de las cifras en el propio folio.
--
-- Ganancia sobre piezas: reparacion_refacciones.precio es lo que se le cobra al cliente por la pieza. NULL en los
-- renglones anteriores (se toma el costo). La configuracion arranca APAGADA: la pieza se cobra a su costo, como siempre.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado), se puede repetir.
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

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

-- Comprobacion: deben salir las 7 columnas de reparaciones, la de piezas y las 2 de la configuracion
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'reparaciones' AND column_name IN ('costos_revisados_at', 'costos_revisados_por', 'revision_entregado_at', 'revision_reparacion', 'revision_mano_obra', 'revision_costo_piezas', 'revision_utilidad'))
   OR (table_name = 'reparacion_refacciones' AND column_name = 'precio')
   OR (table_name = 'configuracion_ticket' AND column_name IN ('reparacion_margen_piezas_activo', 'reparacion_margen_piezas_pct'))
ORDER BY table_name, column_name;
