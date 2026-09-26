-- SOLO LECTURA. Antes de migracion_traslados.sql: muestra en que ubicacion quedaria cada folio abierto
-- (los que estan en diagnostico / esperando autorizacion / reparacion pasan al TALLER; el resto queda
-- en la SUCURSAL) para que lo revises con las sucursales. Una sola tabla: (seccion, folio, sucursal,
-- estado, ubicacion propuesta).

SELECT '1 resumen' AS seccion, s.nombre AS folio, count(*)::text AS sucursal,
       count(*) FILTER (WHERE r.estado IN ('diagnostico', 'esperando_autorizacion', 'reparacion'))::text || ' irian al taller' AS estado,
       count(*) FILTER (WHERE r.estado NOT IN ('diagnostico', 'esperando_autorizacion', 'reparacion'))::text || ' se quedan en la sucursal' AS ubicacion_propuesta
FROM reparaciones r JOIN sucursales s ON s.id = r.sucursal_id
WHERE r.estado NOT IN ('entregado', 'cancelado')
GROUP BY s.nombre

UNION ALL
SELECT '2 detalle', r.folio, s.nombre, r.estado::text,
       CASE WHEN r.estado IN ('diagnostico', 'esperando_autorizacion', 'reparacion') THEN 'TALLER' ELSE 'sucursal' END
FROM reparaciones r JOIN sucursales s ON s.id = r.sucursal_id
WHERE r.estado NOT IN ('entregado', 'cancelado')

UNION ALL
SELECT '3 tecnicos conservan historial', COALESCE(u.nombre, '(sin tecnico)'), '', count(*)::text || ' folios', ''
FROM reparaciones r LEFT JOIN usuarios u ON u.id = r.tecnico_id
WHERE r.tecnico_id IS NOT NULL AND r.estado <> 'recibido'
GROUP BY u.nombre

ORDER BY 1, 2;
