-- Autorizacion de cotizaciones por WhatsApp (agente de TRAI).
-- Cuando el cliente RECHAZA la cotizacion, el folio no cambia de estado (sigue en
-- esperando_autorizacion) y el personal decide si cancela o renegocia; estas dos
-- columnas dejan constancia de cuando lo dijo y de que monto rechazo. Se considera
-- "rechazada" solo mientras el folio siga en esperando_autorizacion y el total
-- sea el mismo monto: si el personal cambia la cotizacion, el aviso se quita solo.
ALTER TABLE reparaciones
  ADD COLUMN IF NOT EXISTS cotizacion_rechazada_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cotizacion_rechazada_monto numeric(12,2);
