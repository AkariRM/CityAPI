-- Inventario de refacciones, separado del catalogo de productos/accesorios.
-- Idempotente -- se puede correr mas de una vez sin romper nada.

CREATE TABLE IF NOT EXISTS refacciones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  nombre        text NOT NULL,
  categoria     text,
  proveedor     text,
  costo         numeric(12,2) NOT NULL DEFAULT 0,
  stock         integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  stock_minimo  integer NOT NULL DEFAULT 0,
  activo        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refacciones_sucursal ON refacciones(sucursal_id);

DROP TRIGGER IF EXISTS trg_refacciones_updated_at ON refacciones;
CREATE TRIGGER trg_refacciones_updated_at BEFORE UPDATE ON refacciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Una refaccion usada en una reparacion ahora puede venir del catalogo de
-- productos (accesorio) O de este inventario dedicado -- exactamente uno
-- de los dos por renglon.
ALTER TABLE reparacion_refacciones ALTER COLUMN producto_id DROP NOT NULL;
ALTER TABLE reparacion_refacciones ADD COLUMN IF NOT EXISTS refaccion_id uuid REFERENCES refacciones(id);
ALTER TABLE reparacion_refacciones DROP CONSTRAINT IF EXISTS chk_reparacion_refaccion_identificada;
ALTER TABLE reparacion_refacciones ADD CONSTRAINT chk_reparacion_refaccion_identificada
  CHECK ((producto_id IS NOT NULL) <> (refaccion_id IS NOT NULL));

-- Mismo criterio para las solicitudes de pieza sin stock.
ALTER TABLE reparacion_solicitudes_pieza ADD COLUMN IF NOT EXISTS refaccion_id uuid REFERENCES refacciones(id);
ALTER TABLE reparacion_solicitudes_pieza DROP CONSTRAINT IF EXISTS chk_solicitud_pieza_identificada;
ALTER TABLE reparacion_solicitudes_pieza ADD CONSTRAINT chk_solicitud_pieza_identificada
  CHECK (producto_id IS NOT NULL OR refaccion_id IS NOT NULL OR descripcion_libre IS NOT NULL);
