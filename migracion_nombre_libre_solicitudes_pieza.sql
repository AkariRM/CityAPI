-- "Solicitar pieza" ya no busca en catalogo (eso se resuelve despues, al
-- aprobar, vinculando una refaccion real) -- ahora captura nombre +
-- descripcion libres. nombre_libre es el nuevo campo corto (equivalente a
-- producto_nombre/refaccion.nombre cuando la pieza si esta en catalogo);
-- descripcion_libre sigue siendo el detalle opcional.
ALTER TABLE reparacion_solicitudes_pieza
  ADD COLUMN IF NOT EXISTS nombre_libre text;

ALTER TABLE reparacion_solicitudes_pieza
  DROP CONSTRAINT IF EXISTS chk_solicitud_pieza_identificada;
ALTER TABLE reparacion_solicitudes_pieza
  ADD CONSTRAINT chk_solicitud_pieza_identificada
  CHECK (producto_id IS NOT NULL OR refaccion_id IS NOT NULL OR nombre_libre IS NOT NULL OR descripcion_libre IS NOT NULL);
