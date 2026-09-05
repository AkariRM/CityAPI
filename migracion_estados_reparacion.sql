-- Agrega los 2 estados nuevos al flujo de reparaciones (pedidos por TRAI
-- para el endpoint /reparacion-externa del agente de WhatsApp):
--   esperando_autorizacion -> se envio cotizacion, falta que el cliente diga si
--   cancelado               -> el folio no procedio (cliente no autorizo, etc.)
--
-- Nota tecnica: ALTER TYPE ... ADD VALUE no puede usarse en la misma
-- transaccion en la que despues se INSERTA/actualiza una fila con ese valor
-- nuevo — por eso este script NO envuelve todo en BEGIN/COMMIT. Cada
-- sentencia corre y se confirma por separado. Es seguro correrlo tal cual,
-- una sola vez.

ALTER TYPE estado_reparacion ADD VALUE IF NOT EXISTS 'esperando_autorizacion' AFTER 'diagnostico';
ALTER TYPE estado_reparacion ADD VALUE IF NOT EXISTS 'cancelado';

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS fecha_estimada_entrega timestamptz;
ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS nota_para_cliente text;

-- Verificar:
-- SELECT unnest(enum_range(NULL::estado_reparacion));
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name IN ('fecha_estimada_entrega', 'nota_para_cliente');
