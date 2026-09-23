-- Politica de credito POR CLIENTE (separada del tipo_precio) -- si el
-- cliente esta autorizado a comprar a credito, su limite total de
-- exposicion (suma de saldos pendientes de todos sus creditos activos) y
-- el plazo por default para calcular fecha_vencimiento de un credito nuevo.
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS permite_credito boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS limite_credito numeric(12,2),
  ADD COLUMN IF NOT EXISTS plazo_dias_credito integer;

-- Fecha limite de pago de un credito especifico -- se calcula al crearlo
-- (created_at + clientes.plazo_dias_credito del cliente, si tiene uno
-- configurado). Un credito 'activo' cuya fecha_vencimiento ya paso se
-- marca 'vencido' de forma perezosa (ver src/utils/creditos.js), no hay
-- cron en este proyecto.
ALTER TABLE creditos
  ADD COLUMN IF NOT EXISTS fecha_vencimiento date;
