ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS imprimir_recibo_auto_reparacion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reactivacion_catalogo_automatica boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bloquear_entrega_con_saldo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pieza_externa_requiere_catalogo boolean NOT NULL DEFAULT false;
