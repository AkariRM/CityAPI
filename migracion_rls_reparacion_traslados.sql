-- Seguridad a nivel de fila (RLS) en reparacion_traslados — idempotente, se puede repetir.
--
-- Auditoria de seguridad del 11 de octubre de 2026: las demas tablas del esquema public ya la tienen activa, esta era la unica que no.
-- Sin RLS, quien tuviera la llave anon de Supabase podria leer y escribir esta tabla directo por la API de datos de Supabase.
-- La API de CityPhone no se ve afectada: se conecta con un usuario que se salta RLS (igual que con todas las demas tablas).
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).

ALTER TABLE reparacion_traslados ENABLE ROW LEVEL SECURITY;

-- Comprobacion: tablas de public SIN RLS (debe dar 0 filas)
SELECT c.relname AS tabla_sin_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY c.relname;
