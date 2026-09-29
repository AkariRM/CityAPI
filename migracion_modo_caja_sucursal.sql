-- Modo de caja por sucursal: 'compartida' (un solo cajon fisico, el corte suma a TODOS los que
-- trabajaron ahi en el turno) o 'individual' (cada cajero cuenta y cuadra el suyo, comportamiento
-- que ya existia). Default 'compartida' porque es como ya opera la mayoria hoy en la practica.
-- Idempotente, sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE sucursales
  ADD COLUMN IF NOT EXISTS modo_caja text NOT NULL DEFAULT 'compartida';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sucursales_modo_caja_check') THEN
    ALTER TABLE sucursales ADD CONSTRAINT sucursales_modo_caja_check CHECK (modo_caja IN ('compartida', 'individual'));
  END IF;
END $$;

-- Comprobación
SELECT nombre, modo_caja FROM sucursales ORDER BY nombre;
