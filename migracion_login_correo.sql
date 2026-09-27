-- Inicio de sesión con correo y contraseña — fase 0 (base de datos). Idempotente.
--
--  1. usuarios.password_hash: la contraseña para entrar con correo. Se llena con el MISMO cifrado del PIN, así que
--     el PIN actual de cada persona sirve como contraseña por el momento (bcrypt no distingue un PIN de una
--     contraseña). Al cambiar su contraseña, el PIN deja de servir.
--  2. Los correos existentes se guardan en minúsculas y sin espacios, y un correo solo puede pertenecer a una cuenta
--     (sin importar mayúsculas).
--
-- No borra ni cambia ningún PIN: el login actual por PIN sigue funcionando durante la transición.
-- Cada sentencia se puede repetir sin efecto (el editor de Supabase las corre por separado).
--
-- Si la ÚLTIMA sentencia falla por "duplicate key", hay dos cuentas con el mismo correo (distinto solo en
-- mayúsculas): corrige uno de los dos desde Usuarios y vuelve a correr este archivo.
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash text;

UPDATE usuarios SET password_hash = pin_hash WHERE password_hash IS NULL;

UPDATE usuarios SET email = NULLIF(lower(btrim(email)), '') WHERE email IS NOT NULL AND email IS DISTINCT FROM NULLIF(lower(btrim(email)), '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_lower ON usuarios (lower(email)) WHERE email IS NOT NULL;

-- Comprobación: cuántas cuentas ya pueden entrar con correo (necesitan un correo) y cuántas aún no
SELECT count(*) FILTER (WHERE email IS NOT NULL AND activo) AS listas_para_entrar_con_correo,
       count(*) FILTER (WHERE email IS NULL AND activo) AS activas_sin_correo,
       count(*) FILTER (WHERE password_hash IS NULL) AS sin_contrasena
FROM usuarios;
