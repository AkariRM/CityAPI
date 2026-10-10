-- Lo que el agente de WhatsApp (Michelle) deja anotado para el personal — idempotente, se puede repetir.
--
-- agente_pendientes: cada "lo checo y te confirmo" del agente (una pregunta que no pudo contestar). El personal la responde en la app y la
--   respuesta se le manda a la persona por WhatsApp.
-- agente_prospectos: personas que escribieron al agente y todavia no son clientes (lo que buscan, presupuesto, seguimiento).
-- cliente_notas_agente: notas que el agente deja de un cliente.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

CREATE SEQUENCE IF NOT EXISTS agente_pendientes_folio_seq;

CREATE TABLE IF NOT EXISTS agente_pendientes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio           text NOT NULL UNIQUE DEFAULT ('PA-' || lpad(nextval('agente_pendientes_folio_seq')::text, 5, '0')),
  telefono        text NOT NULL,
  telefono10      text NOT NULL,
  nombre          text,
  tipo_contacto   text NOT NULL DEFAULT 'prospecto' CHECK (tipo_contacto IN ('cliente', 'prospecto', 'personal')),
  cliente_id      uuid REFERENCES clientes(id) ON DELETE SET NULL,
  pregunta        text NOT NULL,
  contexto        text,
  equipo_interes  text,
  referencia      text,
  estado          text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'respondido', 'descartado')),
  respuesta       text,
  respondido_por  uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  respondido_at   timestamptz,
  aviso_estado    text CHECK (aviso_estado IN ('enviado', 'pendiente', 'fallido', 'no_enviado')),
  aviso_error     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agente_pendientes_estado ON agente_pendientes(estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agente_pendientes_telefono ON agente_pendientes(telefono10);

CREATE OR REPLACE TRIGGER trg_agente_pendientes_updated_at BEFORE UPDATE ON agente_pendientes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agente_prospectos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefono            text NOT NULL,
  telefono10          text NOT NULL UNIQUE,
  nombre              text,
  equipo_interes      text,
  presupuesto         numeric(12,2) CHECK (presupuesto >= 0),
  etapa               text,
  cita_propuesta      text,
  notas               text,
  estado              text NOT NULL DEFAULT 'nuevo' CHECK (estado IN ('nuevo', 'en_seguimiento', 'cerrado', 'descartado')),
  seguimiento_para    date,
  cliente_id          uuid REFERENCES clientes(id) ON DELETE SET NULL,
  primer_contacto_at  timestamptz NOT NULL DEFAULT now(),
  ultimo_contacto_at  timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agente_prospectos_seguimiento ON agente_prospectos(seguimiento_para) WHERE estado IN ('nuevo', 'en_seguimiento');

CREATE OR REPLACE TRIGGER trg_agente_prospectos_updated_at BEFORE UPDATE ON agente_prospectos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS cliente_notas_agente (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  texto       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cliente_notas_agente_cliente ON cliente_notas_agente(cliente_id, created_at DESC);

-- Comprobacion: deben salir 3 filas
SELECT table_name FROM information_schema.tables WHERE table_name IN ('agente_pendientes', 'agente_prospectos', 'cliente_notas_agente') ORDER BY table_name;
