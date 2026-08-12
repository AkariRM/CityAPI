-- ============================================================================
-- Migración: apartados (reservar producto para un cliente con anticipo
-- opcional) + stock_apartado en inventario.
-- Ejecutar una sola vez en el SQL editor de Supabase (producción ya tiene
-- datos, por eso no se puede simplemente re-correr schema.sql completo).
-- ============================================================================

ALTER TABLE inventario ADD COLUMN IF NOT EXISTS stock_apartado integer NOT NULL DEFAULT 0 CHECK (stock_apartado >= 0);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_apartado') THEN
    CREATE TYPE estado_apartado AS ENUM ('activo', 'completado', 'cancelado');
  END IF;
END $$;

ALTER TYPE estado_unidad_imei ADD VALUE IF NOT EXISTS 'apartado';

CREATE SEQUENCE IF NOT EXISTS apartados_folio_seq;
CREATE TABLE IF NOT EXISTS apartados (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio           text NOT NULL UNIQUE DEFAULT ('AP-' || lpad(nextval('apartados_folio_seq')::text, 6, '0')),
  cliente_id      uuid NOT NULL REFERENCES clientes(id),
  sucursal_id     uuid NOT NULL REFERENCES sucursales(id),
  producto_id     uuid NOT NULL REFERENCES productos(id),
  unidad_imei_id  uuid REFERENCES unidades_imei(id),
  cantidad        integer NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio_total    numeric(12,2) NOT NULL,
  monto_abonado   numeric(12,2) NOT NULL DEFAULT 0,
  estado          estado_apartado NOT NULL DEFAULT 'activo',
  usuario_id      uuid NOT NULL REFERENCES usuarios(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apartados_cliente ON apartados(cliente_id);
CREATE INDEX IF NOT EXISTS idx_apartados_producto ON apartados(producto_id, sucursal_id);
CREATE INDEX IF NOT EXISTS idx_apartados_estado ON apartados(estado);

CREATE TABLE IF NOT EXISTS apartado_abonos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apartado_id   uuid NOT NULL REFERENCES apartados(id),
  monto         numeric(12,2) NOT NULL,
  metodo        metodo_pago NOT NULL,
  usuario_id    uuid NOT NULL REFERENCES usuarios(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apartado_abonos_apartado ON apartado_abonos(apartado_id);

DROP TRIGGER IF EXISTS trg_apartados_updated_at ON apartados;
CREATE TRIGGER trg_apartados_updated_at BEFORE UPDATE ON apartados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
