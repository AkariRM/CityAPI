-- Fotos de la reparacion POR ESTADO (1-5 por cada estado) -- se usan para
-- que el agente de WhatsApp (via n8n) responda al cliente con la foto del
-- estado actual. reparacion_fotos ya existia pero ninguna ruta escribia en
-- ella; "etiqueta" (antes/despues/diagnostico) queda como campo heredado.
ALTER TABLE reparacion_fotos
  ADD COLUMN IF NOT EXISTS estado estado_reparacion;

CREATE INDEX IF NOT EXISTS idx_reparacion_fotos_reparacion_estado
  ON reparacion_fotos(reparacion_id, estado);
