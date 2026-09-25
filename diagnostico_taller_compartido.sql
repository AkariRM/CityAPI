-- SOLO LECTURA. Antes de migracion_taller_compartido.sql: muestra que va a pasar con las refacciones
-- y los tecnicos al pasar al taller compartido. Devuelve una sola tabla (seccion, detalle, a, b, c)
-- para que se vea completa en el editor de Supabase; pegame el resultado si quieres que lo revise.

-- 1) Refacciones por sucursal hoy
SELECT '1 refacciones por sucursal' AS seccion, COALESCE(s.nombre, '(sin sucursal)') AS detalle,
       count(*)::text AS a, COALESCE(sum(r.stock), 0)::text AS b, 'piezas distintas / unidades en stock' AS c
FROM refacciones r LEFT JOIN sucursales s ON s.id = r.sucursal_id
WHERE r.activo
GROUP BY s.nombre

UNION ALL
-- 2) Piezas repetidas (mismo nombre en varias filas): se unen en una sola
SELECT '2 se unen (mismo nombre)', min(r.nombre),
       count(*)::text || ' filas',
       'stock total ' || sum(r.stock)::text,
       CASE WHEN count(DISTINCT r.costo) > 1
            THEN 'COSTOS DISTINTOS: ' || string_agg(DISTINCT r.costo::text, ' / ') || ' (queda el de la fila mas reciente)'
            ELSE 'mismo costo ' || min(r.costo)::text END
FROM refacciones r
GROUP BY lower(btrim(regexp_replace(r.nombre, '\s+', ' ', 'g')))
HAVING count(*) > 1

UNION ALL
-- 3) Uso: cuantas reparaciones / solicitudes / movimientos se re-apuntan
SELECT '3 registros que se re-apuntan', 'reparaciones, solicitudes de pieza, movimientos',
       (SELECT count(*) FROM reparacion_refacciones rr JOIN refacciones r ON r.id = rr.refaccion_id
        WHERE (SELECT count(*) FROM refacciones x WHERE lower(btrim(regexp_replace(x.nombre, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(r.nombre, '\s+', ' ', 'g')))) > 1)::text,
       (SELECT count(*) FROM reparacion_solicitudes_pieza sp JOIN refacciones r ON r.id = sp.refaccion_id
        WHERE (SELECT count(*) FROM refacciones x WHERE lower(btrim(regexp_replace(x.nombre, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(r.nombre, '\s+', ' ', 'g')))) > 1)::text,
       (SELECT count(*) FROM movimientos_refacciones m JOIN refacciones r ON r.id = m.refaccion_id
        WHERE (SELECT count(*) FROM refacciones x WHERE lower(btrim(regexp_replace(x.nombre, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(r.nombre, '\s+', ' ', 'g')))) > 1)::text

UNION ALL
-- 4) Tecnicos que hoy llevan sucursal (se les quita)
SELECT '4 tecnicos', u.nombre, COALESCE(s.nombre, '(sin sucursal)'), CASE WHEN u.activo THEN 'activo' ELSE 'inactivo' END, ''
FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
WHERE u.rol = 'tecnico'

UNION ALL
-- 5) Reparaciones abiertas hoy por sucursal y con/sin tecnico (los tecnicos solo ven las asignadas)
SELECT '5 reparaciones abiertas', s.nombre,
       count(*)::text, count(*) FILTER (WHERE r.tecnico_id IS NULL)::text || ' sin tecnico',
       count(*) FILTER (WHERE r.estado = 'listo')::text || ' listas para entregar'
FROM reparaciones r JOIN sucursales s ON s.id = r.sucursal_id
WHERE r.estado NOT IN ('entregado', 'cancelado')
GROUP BY s.nombre

UNION ALL
-- 6) Supervisores actuales (admin): siguen como Supervisores de su sucursal
SELECT '6 supervisores (admin)', u.nombre, COALESCE(s.nombre, '(sin sucursal)'), CASE WHEN u.activo THEN 'activo' ELSE 'inactivo' END, ''
FROM usuarios u LEFT JOIN sucursales s ON s.id = u.sucursal_id
WHERE u.rol = 'admin'

ORDER BY 1, 2;
