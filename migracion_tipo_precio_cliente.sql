-- Nivel de precio (publico/revendedor/mayoreo) asignado a cada cliente,
-- para que Punto de Venta lo aplique solo segun el cliente de la venta en
-- vez de que el vendedor lo elija a mano.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_precio_cliente') THEN
    CREATE TYPE tipo_precio_cliente AS ENUM ('publico', 'revendedor', 'mayoreo');
  END IF;
END $$;

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_precio tipo_precio_cliente NOT NULL DEFAULT 'publico';
