-- ============================================================================
-- Migración: Cambio de equipo por dinero (trade-in) + Órdenes de compra
-- Ejecutar en el SQL editor de Supabase (producción ya tiene datos).
-- ============================================================================

CREATE TYPE grado_cambio_equipo AS ENUM ('A', 'B', 'C', 'D', 'otro');
CREATE TYPE estado_cambio_equipo AS ENUM ('evaluando', 'aceptado', 'rechazado', 'completado');
CREATE TYPE estado_orden_compra AS ENUM ('pendiente', 'recibida');

CREATE TABLE cambios_equipo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id       uuid NOT NULL REFERENCES sucursales(id),
  cliente_id        uuid REFERENCES clientes(id),
  cliente_nombre    text NOT NULL,
  equipo_modelo     text NOT NULL,
  grado             grado_cambio_equipo NOT NULL,
  grado_detalle     text,
  bateria_pct       integer,
  pantalla_ok       boolean NOT NULL DEFAULT true,
  cuerpo_ok         boolean NOT NULL DEFAULT true,
  camaras_ok        boolean NOT NULL DEFAULT true,
  botones_ok        boolean NOT NULL DEFAULT true,
  valor_referencia  numeric(12,2) NOT NULL DEFAULT 0,
  valor_ofrecido    numeric(12,2) NOT NULL DEFAULT 0,
  estado            estado_cambio_equipo NOT NULL DEFAULT 'evaluando',
  producto_id       uuid REFERENCES productos(id),
  usuario_id        uuid REFERENCES usuarios(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cambios_equipo_sucursal ON cambios_equipo(sucursal_id, estado);

CREATE TRIGGER trg_cambios_equipo_updated_at BEFORE UPDATE ON cambios_equipo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ordenes_compra (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id  uuid NOT NULL REFERENCES proveedores(id),
  producto_id   uuid NOT NULL REFERENCES productos(id),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  cantidad      integer NOT NULL CHECK (cantidad > 0),
  estado        estado_orden_compra NOT NULL DEFAULT 'pendiente',
  creado_por    uuid REFERENCES usuarios(id),
  recibido_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ordenes_compra_proveedor ON ordenes_compra(proveedor_id);
CREATE INDEX idx_ordenes_compra_estado ON ordenes_compra(estado);
