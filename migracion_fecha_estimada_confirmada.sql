-- Fecha estimada de entrega confirmada por el cliente — idempotente, se puede repetir.
--
-- Cuando el cliente autoriza la cotizacion (en la sucursal o por WhatsApp) el sistema guarda la fecha estimada que acepto en
-- reparaciones.fecha_estimada_confirmada. Si despues se cambia la fecha, la app avisa que cambio despues de confirmarse.
-- Los folios que ya estaban autorizados (en reparacion, listos o entregados) y tienen fecha se dan por confirmados.
--
-- El relleno no cambia updated_at: desactiva por un momento el trigger de la tabla dentro de un solo bloque (si algo falla se revierte todo).
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS fecha_estimada_confirmada timestamptz;

DO $$
BEGIN
  ALTER TABLE reparaciones DISABLE TRIGGER USER;
  UPDATE reparaciones
  SET fecha_estimada_confirmada = fecha_estimada_entrega
  WHERE fecha_estimada_confirmada IS NULL AND fecha_estimada_entrega IS NOT NULL AND estado IN ('reparacion', 'listo', 'entregado');
  ALTER TABLE reparaciones ENABLE TRIGGER USER;
END $$;

-- Comprobacion: la columna existe (1 fila) y cuantos folios quedaron con fecha confirmada
SELECT 'columna fecha_estimada_confirmada' AS que, count(*)::int AS filas FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name = 'fecha_estimada_confirmada'
UNION ALL
SELECT 'folios con fecha confirmada', count(*)::int FROM reparaciones WHERE fecha_estimada_confirmada IS NOT NULL;
