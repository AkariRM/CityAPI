-- Quita 'supervisor' del enum rol_usuario (quedo agregado por la migracion
-- anterior antes de decidir que no hacia falta un rol nuevo). Postgres no
-- deja hacer DROP VALUE en un enum, asi que se reconstruye el tipo.

-- PASO 1: verificar que nadie quedo con ese rol antes de continuar.
-- Si esto regresa filas, reasigna a esos usuarios a otro rol primero
-- (Usuarios y roles en la app, o UPDATE usuarios SET rol='admin' WHERE id=...)
-- y vuelve a correr este SELECT hasta que salga vacio.
SELECT id, nombre, rol FROM usuarios WHERE rol = 'supervisor';

-- PASO 2: si el SELECT de arriba salio vacio, correr todo esto junto.
CREATE TYPE rol_usuario_new AS ENUM ('dueño', 'admin', 'vendedor', 'tecnico', 'community_manager', 'pto');

ALTER TABLE usuarios ALTER COLUMN rol TYPE rol_usuario_new USING rol::text::rol_usuario_new;
ALTER TABLE precios_especiales ALTER COLUMN rol TYPE rol_usuario_new USING rol::text::rol_usuario_new;

DROP TYPE rol_usuario;
ALTER TYPE rol_usuario_new RENAME TO rol_usuario;
