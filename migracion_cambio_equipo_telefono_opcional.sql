-- La pantalla de Cambio de equipo por dinero ya no pide telefono a mano
-- (se toma solo del cliente vinculado, si hay uno) -- deja de ser obligatorio.
ALTER TABLE cambios_equipo ALTER COLUMN cliente_telefono DROP NOT NULL;
