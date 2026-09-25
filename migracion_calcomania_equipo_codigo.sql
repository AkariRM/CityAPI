-- Calcomania de equipo: que codigo lleva impreso. 'barras' = codigo de barras (Code 128) con el
-- IMEI, que se lee con un lector de mostrador; 'qr' = codigo QR como antes. Se cambia desde
-- Configuracion. Es idempotente: se puede correr mas de una vez.
ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS calcomania_equipo_codigo text NOT NULL DEFAULT 'barras';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_calcomania_equipo_codigo_check'
  ) THEN
    ALTER TABLE configuracion_ticket
      ADD CONSTRAINT configuracion_ticket_calcomania_equipo_codigo_check
      CHECK (calcomania_equipo_codigo IN ('barras', 'qr'));
  END IF;
END $$;
