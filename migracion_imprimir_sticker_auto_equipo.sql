ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS imprimir_sticker_auto_equipo boolean NOT NULL DEFAULT true;
