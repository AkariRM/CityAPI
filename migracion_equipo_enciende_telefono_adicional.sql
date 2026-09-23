-- Recepcion de equipo: dos datos que el negocio pedia en su formulario de
-- reparaciones.
--
-- * "Equipo enciende" (Si/No) se guarda en la reparacion: es un dato de ESE
--   folio (el mismo equipo puede llegar apagado hoy y encendido mañana).
--   Nullable: los folios anteriores no lo capturaron. Solo se ve en la app,
--   no se imprime en comprobante ni calcomania.
-- * "Telefono adicional" se guarda en el cliente, junto a su telefono
--   principal, para reutilizarlo en visitas futuras.
ALTER TABLE reparaciones
  ADD COLUMN IF NOT EXISTS equipo_enciende boolean;

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS telefono_adicional text;
