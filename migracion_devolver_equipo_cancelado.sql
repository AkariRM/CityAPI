-- Devolver al cliente el equipo de una reparacion CANCELADA — idempotente, se puede repetir.
--
-- Un folio cancelado (el cliente no autorizo la cotizacion o se cancelo a mano) no pasa a "entregado": no hay cobro ni revision de costos.
-- Pero el equipo sigue fisicamente en la tienda (o en el taller) hasta que se le devuelve al cliente. reparaciones.equipo_devuelto_at marca
-- cuando se devolvio: NULL = todavia no, y el folio aparece en Recepcion/Entrega para devolverlo.
--
-- Los folios que ya estaban cancelados ANTES del 10 de octubre de 2026 se dan por devueltos (si no, todos aparecerian como pendientes).
-- Los cancelados desde esa fecha quedan pendientes de devolver. Repetir la migracion no cambia nada mas.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS equipo_devuelto_at timestamptz;

UPDATE reparaciones
SET equipo_devuelto_at = updated_at
WHERE estado = 'cancelado' AND equipo_devuelto_at IS NULL AND updated_at < '2026-10-10'::timestamptz;

-- Comprobacion: la columna existe (1 fila) y cuantos cancelados quedan por devolver
SELECT 'columna equipo_devuelto_at' AS que, count(*)::int AS filas FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name = 'equipo_devuelto_at'
UNION ALL
SELECT 'cancelados por devolver', count(*)::int FROM reparaciones WHERE estado = 'cancelado' AND equipo_devuelto_at IS NULL;
