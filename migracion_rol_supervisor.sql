-- Rol nuevo "supervisor". Idempotente (ADD VALUE IF NOT EXISTS).
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'supervisor';
