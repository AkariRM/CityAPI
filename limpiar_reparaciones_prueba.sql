-- Borra TODAS las reparaciones (folios) y lo que dependa de ellas, para arrancar el taller compartido
-- (con traslados) con la base limpia. Uso ÚNICO de reinicio pre-producción, confirmado por el usuario
-- ("todos los datos son de prueba, no es producción") — NO usar esto una vez que haya reparaciones
-- reales que importen.
--
-- Correr primero diagnostico_limpiar_reparaciones.sql para ver qué se va a borrar.
-- Recomendado antes de correr: Supabase -> Database -> Backups (o exportar las tablas) por si acaso.
--
-- Qué SÍ borra:
--   1. gastos "Piezas de reparación" que nacieron de piezas pedidas para un folio (si no, quedarían
--      gastos huérfanos en los reportes financieros)
--   2. reparaciones, y por ON DELETE CASCADE: piezas usadas, abonos/cobros, solicitudes de pieza,
--      historial, traslados, fotos (solo el registro) y avisos al cliente
--   3. reinicia el consecutivo de folios: el próximo folio será R-000001
--
-- Qué NO borra:
--   - clientes, usuarios, sucursales, productos/equipos (incluye equipos propios que estaban en
--     revisión: quedan tal cual; ver el renglón 9 del diagnóstico)
--   - inventario de refacciones ni su historial de movimientos (el stock queda como está; si las
--     piezas de prueba ya se gastaron, ajústalo desde Refacciones)
--   - gastos generales (compras de refacciones, renta, etc.) ni sueldos
--   - los archivos de las fotos en Storage (SQL no los puede borrar; son solo de prueba)
--
-- Todo corre en una transacción: si algo falla a la mitad, no se borra nada. Ejecutar en el SQL
-- Editor de Supabase.

BEGIN;

DELETE FROM gastos
WHERE categoria = 'Piezas de reparación'
  AND descripcion LIKE 'Pieza de reparación folio %';

DELETE FROM reparaciones;

ALTER SEQUENCE reparaciones_folio_seq RESTART WITH 1;

COMMIT;

-- Verificación: todo debe salir en 0.
SELECT 'reparaciones' AS tabla, count(*) AS quedan FROM reparaciones
UNION ALL SELECT 'reparacion_refacciones', count(*) FROM reparacion_refacciones
UNION ALL SELECT 'reparacion_abonos', count(*) FROM reparacion_abonos
UNION ALL SELECT 'reparacion_solicitudes_pieza', count(*) FROM reparacion_solicitudes_pieza
UNION ALL SELECT 'reparacion_historial', count(*) FROM reparacion_historial
UNION ALL SELECT 'reparacion_fotos', count(*) FROM reparacion_fotos
UNION ALL SELECT 'notificaciones_cliente', count(*) FROM notificaciones_cliente
UNION ALL SELECT 'gastos de piezas de reparación', count(*) FROM gastos WHERE categoria = 'Piezas de reparación' AND descripcion LIKE 'Pieza de reparación folio %';
