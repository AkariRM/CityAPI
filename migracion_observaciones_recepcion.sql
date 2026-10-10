-- Observaciones adicionales al recibir un equipo — idempotente, se puede repetir.
--
-- Texto libre y opcional que escribe el mostrador al recibir el equipo: estado fisico (rayones, pantalla estrellada, golpes),
-- accesorios que deja el cliente (funda, cargador, SIM), o cualquier detalle que no cabe en "problema reportado".
-- Es distinto del problema reportado (lo que dice el cliente que falla) y del diagnostico (lo que encuentra el taller).
-- Los folios anteriores quedan en NULL.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS observaciones_recepcion text;

-- Comprobacion: la columna existe (1 fila)
SELECT 'columna observaciones_recepcion' AS que, count(*)::int AS filas FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name = 'observaciones_recepcion';
