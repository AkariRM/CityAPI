-- Bitacora de movimientos de refacciones (la que muestra Stock/Kardex). Las
-- refacciones tienen su propio stock (refacciones.stock), aparte de
-- productos/inventario, asi que no podian usar movimientos_inventario.
-- Registra: stock inicial al darla de alta, compras, uso en reparaciones,
-- sobrante de piezas solicitadas y ajustes manuales (Nuevo movimiento).
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
