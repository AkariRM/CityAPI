-- Catálogo de ejemplo para probar el Punto de Venta.
-- Asume que ya existe una sucursal llamada 'Centro' (creada al sembrar tu cuenta admin).
-- Seguro de correr varias veces: no duplica ni la categoría ni los productos.

INSERT INTO categorias (nombre)
SELECT 'Accesorios' WHERE NOT EXISTS (SELECT 1 FROM categorias WHERE nombre = 'Accesorios');

WITH cat AS (SELECT id FROM categorias WHERE nombre = 'Accesorios' LIMIT 1),
     suc AS (SELECT id FROM sucursales WHERE nombre = 'Centro' LIMIT 1),
     candidatos (nombre, precio, costo) AS (VALUES
       ('Mica templada iPhone 13', 249, 80),
       ('Funda transparente iPhone 13', 199, 60),
       ('Cargador tipo C 20W', 349, 150),
       ('Audífonos Bluetooth', 599, 280)
     ),
     nuevos AS (
       INSERT INTO productos (nombre, categoria_id, tipo, precio_venta, costo)
       SELECT c.nombre, cat.id, 'accesorio', c.precio, c.costo
       FROM candidatos c, cat
       WHERE NOT EXISTS (SELECT 1 FROM productos p WHERE p.nombre = c.nombre)
       RETURNING id
     )
INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
SELECT nuevos.id, suc.id, 20
FROM nuevos, suc;
