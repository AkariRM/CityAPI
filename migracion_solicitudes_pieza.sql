DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_solicitud_pieza') THEN
    CREATE TYPE estado_solicitud_pieza AS ENUM ('pendiente', 'aprobada', 'rechazada', 'recibida');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reparacion_solicitudes_pieza (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id            uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  producto_id              uuid REFERENCES productos(id),
  descripcion_libre        text,
  costo_estimado           numeric(12,2) NOT NULL DEFAULT 0,
  estado                   estado_solicitud_pieza NOT NULL DEFAULT 'pendiente',
  solicitado_por           uuid NOT NULL REFERENCES usuarios(id),
  aprobado_por             uuid REFERENCES usuarios(id),
  motivo_rechazo           text,
  reparacion_refaccion_id  uuid REFERENCES reparacion_refacciones(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_solicitud_pieza_identificada CHECK (producto_id IS NOT NULL OR descripcion_libre IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_solicitudes_pieza_reparacion ON reparacion_solicitudes_pieza(reparacion_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_pieza_estado ON reparacion_solicitudes_pieza(estado);

DROP TRIGGER IF EXISTS trg_reparacion_solicitudes_pieza_updated_at ON reparacion_solicitudes_pieza;
CREATE TRIGGER trg_reparacion_solicitudes_pieza_updated_at BEFORE UPDATE ON reparacion_solicitudes_pieza
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
