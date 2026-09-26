-- SOLO LECTURA. Muestra qué se borraría con limpiar_reparaciones_prueba.sql, sin tocar nada.
-- Ejecutar en el SQL Editor de Supabase ANTES de la limpieza.

SELECT orden, concepto, cantidad, detalle
FROM (
  SELECT 1 AS orden, 'Reparaciones (folios)' AS concepto, count(*)::numeric AS cantidad,
         COALESCE(string_agg(DISTINCT estado::text, ', '), '—') AS detalle
  FROM reparaciones

  UNION ALL
  SELECT 2, 'Abonos / cobros de reparación', count(*), 'Suma: $' || COALESCE(sum(monto), 0)::text
  FROM reparacion_abonos

  UNION ALL
  SELECT 3, 'Piezas usadas en folios', count(*), 'Piezas (unidades): ' || COALESCE(sum(cantidad), 0)::text
  FROM reparacion_refacciones

  UNION ALL
  SELECT 4, 'Solicitudes de pieza', count(*), COALESCE(string_agg(DISTINCT estado::text, ', '), '—')
  FROM reparacion_solicitudes_pieza

  UNION ALL
  SELECT 5, 'Historial (línea de tiempo)', count(*), '—'
  FROM reparacion_historial

  UNION ALL
  SELECT 6, 'Fotos de folios (registros)', count(*), 'Los archivos quedan en Storage; ver la lista de abajo'
  FROM reparacion_fotos

  UNION ALL
  SELECT 7, 'Avisos al cliente registrados', count(*), '—'
  FROM notificaciones_cliente

  UNION ALL
  SELECT 8, 'Gastos "Piezas de reparación" (piezas pedidas por folio)', count(*), 'Suma: $' || COALESCE(sum(monto), 0)::text
  FROM gastos
  WHERE categoria = 'Piezas de reparación' AND descripcion LIKE 'Pieza de reparación folio %'

  UNION ALL
  -- Equipos propios mandados a revisión: el producto queda oculto del catálogo hasta que el folio pasa a "listo".
  -- La limpieza NO los toca; si aparece alguno aquí, reactívalo o bórralo desde Equipos.
  SELECT 9, 'Equipos propios en revisión (ocultos del catálogo)', count(*),
         COALESCE(string_agg(DISTINCT p.nombre, ', '), '—')
  FROM reparaciones r
  JOIN productos p ON p.id = r.producto_id
  WHERE r.origen_reparacion = 'compra_propia' AND p.activo = false

  UNION ALL
  -- Lo que NO se toca, para que quede claro.
  SELECT 10, 'Refacciones en inventario (NO se tocan)', count(*), 'Stock actual: ' || COALESCE(sum(stock), 0)::text
  FROM refacciones
) t
ORDER BY orden;

-- Fotos: URLs de los archivos que quedarían huérfanos en el bucket de Storage (opcional borrarlos a mano).
-- SELECT r.folio, f.url FROM reparacion_fotos f JOIN reparaciones r ON r.id = f.reparacion_id ORDER BY r.folio;
