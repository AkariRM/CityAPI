-- Borra TODOS los equipos (productos.tipo IN ('nuevo','usado')) y todo lo
-- que dependa de ellos, para poder volver a importarlos desde Excel con el
-- color ya separado del nombre. Uso ÚNICO de reinicio pre-producción,
-- confirmado explícitamente por el usuario ("aun no estamos en produccion,
-- solo por esta vez borralos") — NO usar esto una vez que haya ventas o
-- inventario reales que importen.
--
-- Qué SÍ borra (en este orden, por las llaves foráneas):
--   1. apartado_abonos  de apartados de estos equipos
--   2. apartados        de estos equipos
--   3. venta_items      de estos equipos (deja la venta sin ese renglón —
--                       si era el único, la venta queda con 0 artículos)
--   4. cambios          donde el producto devuelto o el nuevo sea uno de estos
--   5. reparacion_refacciones de estos equipos (si alguno se usó como refacción)
--   6. marketplace_listados   de estos equipos
--   7. precios_especiales     de estos equipos
--   8. ordenes_compra         de estos equipos
--   9. movimientos_inventario (kardex) de estos equipos
--  10. unidades_imei          de estos equipos
--  11. inventario             (stock por sucursal) de estos equipos
--  12. producto_imagenes      se borra solo (ON DELETE CASCADE)
--  13. productos              los equipos mismos
--
-- Qué NO borra: accesorios/servicios (otro tipo de producto), clientes,
-- usuarios, sucursales, reparaciones (solo se limpia su referencia si
-- usaban una de estas piezas), publicaciones/promociones de marketing (solo
-- se les quita la referencia al producto, el texto/historial de la
-- publicación se conserva).
--
-- Todo corre dentro de una transacción: si algo falla a la mitad, no se
-- borra nada (ROLLBACK automático). Ejecutar en el SQL Editor de Supabase.

BEGIN;

-- Referencia: cuántos equipos se van a borrar (revisar antes de correr el resto)
-- SELECT count(*) FROM productos WHERE tipo IN ('nuevo', 'usado');

DELETE FROM apartado_abonos
WHERE apartado_id IN (
  SELECT id FROM apartados WHERE producto_id IN (
    SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado')
  )
);

DELETE FROM apartados
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM venta_items
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM cambios
WHERE producto_devuelto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'))
   OR producto_nuevo_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM reparacion_refacciones
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM marketplace_listados
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM precios_especiales
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM ordenes_compra
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM movimientos_inventario
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

-- Referencias opcionales (nullable): se limpia el enlace, no se borra el registro.
UPDATE cambios_equipo SET producto_id = NULL
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

UPDATE publicaciones SET producto_id = NULL
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

UPDATE promociones SET producto_id = NULL
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM unidades_imei
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

DELETE FROM inventario
WHERE producto_id IN (SELECT id FROM productos WHERE tipo IN ('nuevo', 'usado'));

-- producto_imagenes se borra solo por ON DELETE CASCADE al borrar productos.
DELETE FROM productos WHERE tipo IN ('nuevo', 'usado');

COMMIT;
