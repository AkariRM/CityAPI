-- Apartados que hace el agente de WhatsApp (TRAI) -- POST /apartado-externo.
--
-- IMPORTANTE: correr ANTES de desplegar la version del servidor que la usa.
-- Es idempotente (se puede correr mas de una vez).
--
-- 1) Estado propio 'vencido': una reserva del agente que se quedo sin tiempo. Libera
--    el stock igual que cancelar, pero se distingue de "alguien la cancelo".
--    (ALTER TYPE ... ADD VALUE va solo: el valor nuevo no se usa en esta misma corrida.)
ALTER TYPE estado_apartado ADD VALUE IF NOT EXISTS 'vencido';

-- 2) Apartados: quien lo creo y hasta cuando vale.
--    - origen: 'personal' (desde la app, como siempre) o 'agente'.
--    - vence_at: hora limite. NULL = no vence (todos los del personal, y los del agente
--      que ya recibieron un abono: significa que el cliente si paso a pagar).
--    - usuario_id ya no es obligatorio: el agente no es un usuario de la app.
ALTER TABLE apartados
  ADD COLUMN IF NOT EXISTS origen   text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS vence_at timestamptz;
ALTER TABLE apartados ALTER COLUMN usuario_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apartados_origen_check') THEN
    ALTER TABLE apartados ADD CONSTRAINT apartados_origen_check CHECK (origen IN ('personal', 'agente'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_apartados_vence ON apartados(vence_at) WHERE estado = 'activo' AND vence_at IS NOT NULL;

-- 3) Clientes: marca de quien los dio de alta (el agente registra automaticamente
--    a quien aparta con un numero nuevo).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'personal';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clientes_origen_check') THEN
    ALTER TABLE clientes ADD CONSTRAINT clientes_origen_check CHECK (origen IN ('personal', 'agente_whatsapp'));
  END IF;
END $$;

-- 4) Configuracion (pantalla Configuracion de la app): duracion de la reserva y
--    cuantas puede tener a la vez un mismo telefono.
ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS agente_apartado_horas integer NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS agente_apartado_max_por_telefono integer NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_agente_apartado_horas_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_agente_apartado_horas_check
      CHECK (agente_apartado_horas BETWEEN 1 AND 720);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_agente_apartado_max_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_agente_apartado_max_check
      CHECK (agente_apartado_max_por_telefono BETWEEN 1 AND 10);
  END IF;
END $$;
