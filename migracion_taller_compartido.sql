-- Taller de reparacion compartido por todas las sucursales — fase 1.
-- Corre PRIMERO diagnostico_taller_compartido.sql para revisar que se va a unir. Es idempotente.
--
--  1. Rol nuevo 'supervisor_taller' (supervisa el taller; sin sucursal, sin acceso a ventas/caja).
--  2. Los tecnicos dejan de llevar sucursal (estan ligados al taller).
--  3. Las refacciones pasan a ser UN SOLO inventario: se une la misma pieza que estaba repetida en
--     varias sucursales (mismo nombre, sin importar mayusculas ni espacios) sumando su stock y su
--     stock minimo, se conserva el costo de la fila mas reciente, y las reparaciones, solicitudes de
--     pieza y movimientos que la usaban pasan a la fila que queda. Despues sucursal_id queda NULL.
--
-- No depende de BEGIN/COMMIT: el editor de Supabase puede correr cada sentencia por separado, y una
-- tabla temporal no sobrevive de una sentencia a otra. Por eso la union va en UN solo bloque DO
-- (una sentencia = atomica) y cada paso se puede repetir sin efecto.
--
-- Orden de publicacion: esta migracion -> Render -> dist.

-- Un valor nuevo de enum no se puede usar en la misma transaccion en que se crea (aqui no se usa).
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'supervisor_taller';

ALTER TABLE refacciones ALTER COLUMN sucursal_id DROP NOT NULL;
ALTER TABLE movimientos_refacciones ALTER COLUMN sucursal_id DROP NOT NULL;

-- Une las refacciones repetidas entre sucursales. Todo en un bloque: la tabla temporal solo vive
-- dentro de esta sentencia.
DO $$
BEGIN
  DROP TABLE IF EXISTS _refacciones_union;

  -- Cada refaccion y la fila que se queda con su nombre (la activa mas reciente).
  CREATE TEMP TABLE _refacciones_union AS
  SELECT id,
         first_value(id) OVER (
           PARTITION BY lower(btrim(regexp_replace(nombre, '\s+', ' ', 'g')))
           ORDER BY activo DESC, updated_at DESC, created_at ASC, id
         ) AS destino
  FROM refacciones;

  -- Lo que usaba una fila repetida pasa a la que se queda.
  UPDATE reparacion_refacciones rr SET refaccion_id = u.destino
  FROM _refacciones_union u WHERE rr.refaccion_id = u.id AND u.id <> u.destino;

  UPDATE reparacion_solicitudes_pieza sp SET refaccion_id = u.destino
  FROM _refacciones_union u WHERE sp.refaccion_id = u.id AND u.id <> u.destino;

  UPDATE movimientos_refacciones m SET refaccion_id = u.destino
  FROM _refacciones_union u WHERE m.refaccion_id = u.id AND u.id <> u.destino;

  -- Stock y stock minimo de la fila que se queda = suma de todas las que se unen.
  UPDATE refacciones r SET stock = s.stock, stock_minimo = s.minimo
  FROM (
    SELECT u.destino, sum(x.stock)::int AS stock, sum(x.stock_minimo)::int AS minimo
    FROM _refacciones_union u JOIN refacciones x ON x.id = u.id
    GROUP BY u.destino
    HAVING count(*) > 1
  ) s
  WHERE r.id = s.destino;

  DELETE FROM refacciones WHERE id IN (SELECT id FROM _refacciones_union WHERE id <> destino);

  DROP TABLE _refacciones_union;
END $$;

UPDATE refacciones SET sucursal_id = NULL WHERE sucursal_id IS NOT NULL;

-- Los tecnicos son del taller, no de una sucursal.
UPDATE usuarios SET sucursal_id = NULL WHERE rol = 'tecnico' AND sucursal_id IS NOT NULL;
