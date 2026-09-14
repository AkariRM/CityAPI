ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS monto_pagado numeric(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS reparacion_abonos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  monto          numeric(12,2) NOT NULL,
  metodo         metodo_pago NOT NULL,
  usuario_id     uuid NOT NULL REFERENCES usuarios(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reparacion_abonos_reparacion ON reparacion_abonos(reparacion_id);
