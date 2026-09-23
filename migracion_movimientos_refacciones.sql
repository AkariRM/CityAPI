-- Bitacora de movimientos MANUALES de refacciones (Stock/Kardex -> Nuevo
-- movimiento). Las refacciones tienen su propio stock (refacciones.stock),
-- aparte de productos/inventario, asi que no podian usar
-- movimientos_inventario. Por ahora solo registra los ajustes hechos desde
-- Kardex -- las compras y el uso en reparaciones siguen sin pasar por aqui.
CREATE TABLE IF NOT EXISTS movimientos_refacciones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refaccion_id  uuid NOT NULL REFERENCES refacciones(id),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  tipo          tipo_movimiento_inventario NOT NULL,
  cantidad      integer NOT NULL,
  motivo        text,
  usuario_id    uuid REFERENCES usuarios(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movimientos_refacciones ON movimientos_refacciones(refaccion_id, sucursal_id);
