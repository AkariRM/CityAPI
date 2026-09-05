-- Diagnostico de Bloque 2.3 (TRAI): busca equipos activos cuyo precio de
-- venta se ve sospechosamente bajo para lo que dice el nombre — candidatos
-- a ser refacciones/piezas o equipos incompletos capturados por error como
-- si fueran un equipo completo. Es SOLO LECTURA, no cambia nada — sirve
-- para que revisen a mano cuales de verdad son piezas y les ajusten el
-- tipo/categoria.
--
-- El umbral (2500) es arbitrario — ajustenlo segun lo que sepan que es un
-- precio real minimo para un celular completo en su catalogo.

SELECT p.id, p.nombre, p.tipo, p.marca, p.color, p.precio_venta, p.activo
FROM productos p
WHERE p.activo = true
  AND p.tipo IN ('nuevo', 'usado')
  AND p.precio_venta < 2500
ORDER BY p.precio_venta ASC;
