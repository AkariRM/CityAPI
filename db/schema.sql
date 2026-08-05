-- ============================================================================
-- CityPhone SGI — esquema completo de base de datos (PostgreSQL 14+)
--
-- Este archivo es la fuente de verdad de la estructura de la DB. Ejecutarlo
-- completo contra una base vacia (local, Supabase, la que sea) reconstruye
-- el esquema desde cero. Para reiniciar un entorno de desarrollo existente:
--   DROP SCHEMA public CASCADE; CREATE SCHEMA public;
-- y volver a correr este archivo completo.
--
-- Mientras no haya datos reales en produccion, los cambios se hacen editando
-- este mismo archivo. Cuando el sistema ya este en vivo con datos de clientes,
-- los cambios futuros se manejaran como migraciones incrementales aparte.
-- ============================================================================

-- gen_random_uuid() es nativo desde PostgreSQL 13, no requiere extension.

-- ============================================================================
-- FUNCION UTILITARIA: mantiene updated_at al dia en cualquier tabla que la use
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE rol_usuario AS ENUM ('admin', 'vendedor', 'tecnico', 'community_manager');
CREATE TYPE metodo_pago AS ENUM ('efectivo', 'tarjeta', 'credito');
CREATE TYPE estado_venta AS ENUM ('completada', 'cancelada');
CREATE TYPE tipo_producto AS ENUM ('nuevo', 'usado', 'accesorio', 'servicio');
CREATE TYPE estado_unidad_imei AS ENUM ('disponible', 'vendido', 'en_garantia', 'en_reparacion', 'baja');
CREATE TYPE tipo_movimiento_inventario AS ENUM ('entrada', 'salida', 'ajuste', 'traspaso');
CREATE TYPE estado_credito AS ENUM ('activo', 'pagado', 'vencido', 'cancelado');
CREATE TYPE estado_reparacion AS ENUM ('recibido', 'diagnostico', 'reparacion', 'listo', 'entregado');
CREATE TYPE prioridad_reparacion AS ENUM ('baja', 'media', 'alta');
CREATE TYPE etiqueta_foto_reparacion AS ENUM ('antes', 'despues', 'diagnostico');
CREATE TYPE canal_notificacion_cliente AS ENUM ('whatsapp', 'sms');
CREATE TYPE estado_notificacion_cliente AS ENUM ('pendiente', 'enviado', 'fallido');
CREATE TYPE plataforma_publicacion AS ENUM ('instagram', 'facebook');
CREATE TYPE estado_publicacion AS ENUM ('borrador', 'programado', 'publicado');
CREATE TYPE canal_conversacion AS ENUM ('whatsapp', 'instagram');
CREATE TYPE estado_conversacion AS ENUM ('activa', 'cerrada', 'escalada');
CREATE TYPE remitente_mensaje AS ENUM ('cliente', 'ia', 'humano');

-- ============================================================================
-- NUCLEO: sucursales, usuarios, sesiones, auditoria
-- ============================================================================

CREATE TABLE sucursales (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  direccion   text,
  telefono    text,
  activo      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usuarios (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            text NOT NULL,
  telefono          text,
  email             text UNIQUE,
  rol               rol_usuario NOT NULL,
  sucursal_id       uuid REFERENCES sucursales(id),
  pin_hash          text NOT NULL,
  intentos_fallidos smallint NOT NULL DEFAULT 0,
  bloqueado_hasta   timestamptz,
  avatar_color      text,
  activo            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usuarios_rol ON usuarios(rol);
CREATE INDEX idx_usuarios_sucursal ON usuarios(sucursal_id);

CREATE TABLE sesiones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   uuid NOT NULL REFERENCES usuarios(id),
  sucursal_id  uuid REFERENCES sucursales(id),
  token_hash   text NOT NULL,
  ip           inet,
  user_agent   text,
  expira_at    timestamptz NOT NULL,
  revocada_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX idx_sesiones_token_hash ON sesiones(token_hash);

CREATE TABLE auditoria (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id     uuid REFERENCES usuarios(id),
  accion         text NOT NULL,
  entidad        text NOT NULL,
  entidad_id     uuid,
  datos_previos  jsonb,
  datos_nuevos   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_entidad ON auditoria(entidad, entidad_id);
CREATE INDEX idx_auditoria_usuario ON auditoria(usuario_id);

-- ============================================================================
-- CLIENTES
-- ============================================================================

CREATE TABLE clientes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  telefono    text,
  email       text,
  direccion   text,
  notas       text,
  sucursal_id uuid REFERENCES sucursales(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clientes_telefono ON clientes(telefono);

-- ============================================================================
-- CATALOGO, INVENTARIO Y PROVEEDORES
-- ============================================================================

CREATE TABLE categorias (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proveedores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  contacto    text,
  telefono    text,
  email       text,
  notas       text,
  activo      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE productos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku            text UNIQUE,
  nombre         text NOT NULL,
  categoria_id   uuid REFERENCES categorias(id),
  tipo           tipo_producto NOT NULL,
  marca          text,
  modelo         text,
  descripcion    text,
  precio_venta   numeric(12,2) NOT NULL DEFAULT 0,
  costo          numeric(12,2) NOT NULL DEFAULT 0,
  proveedor_id   uuid REFERENCES proveedores(id),
  imagen_url     text,
  activo         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_productos_categoria ON productos(categoria_id);
CREATE INDEX idx_productos_tipo ON productos(tipo);
CREATE INDEX idx_productos_proveedor ON productos(proveedor_id);

-- Existencia agregada por sucursal. Esta es la cifra de verdad de "cuantos hay",
-- independientemente de si se les asigno IMEI individual o no.
CREATE TABLE inventario (
  producto_id     uuid NOT NULL REFERENCES productos(id),
  sucursal_id     uuid NOT NULL REFERENCES sucursales(id),
  stock_cantidad  integer NOT NULL DEFAULT 0 CHECK (stock_cantidad >= 0),
  stock_minimo    integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producto_id, sucursal_id)
);

-- Rastreo opcional por unidad (IMEI). No todas las unidades de un producto
-- necesitan fila aqui: de 5 iPhones en stock puede haber solo 3 con IMEI capturado.
CREATE TABLE unidades_imei (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id        uuid NOT NULL REFERENCES productos(id),
  sucursal_id        uuid NOT NULL REFERENCES sucursales(id),
  imei               text NOT NULL UNIQUE,
  condicion          text,
  costo_adquisicion  numeric(12,2),
  estado             estado_unidad_imei NOT NULL DEFAULT 'disponible',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_unidades_imei_producto ON unidades_imei(producto_id, sucursal_id);
CREATE INDEX idx_unidades_imei_estado ON unidades_imei(estado);

-- Kardex: historial de entradas/salidas/ajustes/traspasos de inventario.
CREATE TABLE movimientos_inventario (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id      uuid NOT NULL REFERENCES productos(id),
  sucursal_id      uuid NOT NULL REFERENCES sucursales(id),
  tipo             tipo_movimiento_inventario NOT NULL,
  cantidad         integer NOT NULL,
  motivo           text,
  referencia_tipo  text,
  referencia_id    uuid,
  usuario_id       uuid REFERENCES usuarios(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_movimientos_producto ON movimientos_inventario(producto_id, sucursal_id);
CREATE INDEX idx_movimientos_referencia ON movimientos_inventario(referencia_tipo, referencia_id);

CREATE TABLE precios_especiales (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id  uuid NOT NULL REFERENCES productos(id),
  cliente_id   uuid REFERENCES clientes(id),
  rol          rol_usuario,
  precio       numeric(12,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (cliente_id IS NOT NULL OR rol IS NOT NULL)
);
CREATE INDEX idx_precios_especiales_producto ON precios_especiales(producto_id);

-- ============================================================================
-- VENTAS, PUNTO DE VENTA Y CAJA
-- ============================================================================

CREATE SEQUENCE ventas_folio_seq;

CREATE TABLE ventas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio        text NOT NULL UNIQUE DEFAULT ('V-' || lpad(nextval('ventas_folio_seq')::text, 6, '0')),
  sucursal_id  uuid NOT NULL REFERENCES sucursales(id),
  vendedor_id  uuid NOT NULL REFERENCES usuarios(id),
  cliente_id   uuid REFERENCES clientes(id),
  subtotal     numeric(12,2) NOT NULL DEFAULT 0,
  descuento    numeric(12,2) NOT NULL DEFAULT 0,
  total        numeric(12,2) NOT NULL DEFAULT 0,
  metodo_pago  metodo_pago NOT NULL,
  estado       estado_venta NOT NULL DEFAULT 'completada',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ventas_sucursal ON ventas(sucursal_id);
CREATE INDEX idx_ventas_vendedor ON ventas(vendedor_id);
CREATE INDEX idx_ventas_cliente ON ventas(cliente_id);

CREATE TABLE venta_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id         uuid NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id      uuid NOT NULL REFERENCES productos(id),
  unidad_imei_id   uuid REFERENCES unidades_imei(id),
  cantidad         integer NOT NULL CHECK (cantidad > 0),
  precio_unitario  numeric(12,2) NOT NULL,
  descuento        numeric(12,2) NOT NULL DEFAULT 0,
  subtotal         numeric(12,2) NOT NULL
);
CREATE INDEX idx_venta_items_venta ON venta_items(venta_id);
CREATE INDEX idx_venta_items_producto ON venta_items(producto_id);
-- Una unidad serializada no se puede vender dos veces.
CREATE UNIQUE INDEX idx_venta_items_unidad_imei_unica ON venta_items(unidad_imei_id) WHERE unidad_imei_id IS NOT NULL;

CREATE TABLE cambios (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_original_id     uuid NOT NULL REFERENCES ventas(id),
  producto_devuelto_id  uuid NOT NULL REFERENCES productos(id),
  producto_nuevo_id     uuid REFERENCES productos(id),
  diferencia            numeric(12,2) NOT NULL DEFAULT 0,
  motivo                text,
  usuario_id            uuid NOT NULL REFERENCES usuarios(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cambios_venta ON cambios(venta_original_id);

CREATE TABLE cortes_caja (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id     uuid NOT NULL REFERENCES sucursales(id),
  usuario_id      uuid NOT NULL REFERENCES usuarios(id),
  turno_inicio    timestamptz NOT NULL,
  turno_fin       timestamptz,
  fondo_inicial   numeric(12,2) NOT NULL DEFAULT 0,
  total_efectivo  numeric(12,2) NOT NULL DEFAULT 0,
  total_tarjeta   numeric(12,2) NOT NULL DEFAULT 0,
  total_credito   numeric(12,2) NOT NULL DEFAULT 0,
  total_sistema   numeric(12,2) NOT NULL DEFAULT 0,
  diferencia      numeric(12,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cortes_caja_sucursal ON cortes_caja(sucursal_id);
CREATE INDEX idx_cortes_caja_usuario ON cortes_caja(usuario_id);

-- ============================================================================
-- CREDITOS Y PAGOS (STRIPE)
-- ============================================================================

CREATE TABLE creditos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id        uuid NOT NULL REFERENCES clientes(id),
  venta_id          uuid REFERENCES ventas(id),
  monto_total       numeric(12,2) NOT NULL,
  saldo_pendiente   numeric(12,2) NOT NULL,
  autorizado_por    uuid NOT NULL REFERENCES usuarios(id),
  limite_aprobado   numeric(12,2),
  condiciones       text,
  estado            estado_credito NOT NULL DEFAULT 'activo',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_creditos_cliente ON creditos(cliente_id);
CREATE INDEX idx_creditos_estado ON creditos(estado);

CREATE TABLE abonos (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credito_id               uuid NOT NULL REFERENCES creditos(id),
  monto                    numeric(12,2) NOT NULL,
  metodo                   metodo_pago NOT NULL,
  stripe_payment_intent_id text,
  usuario_id               uuid NOT NULL REFERENCES usuarios(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_abonos_credito ON abonos(credito_id);

CREATE TABLE pagos_stripe (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo           text NOT NULL CHECK (tipo IN ('venta', 'credito', 'abono')),
  referencia_id  uuid NOT NULL,
  stripe_id      text NOT NULL UNIQUE,
  monto          numeric(12,2) NOT NULL,
  estado         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pagos_stripe_referencia ON pagos_stripe(tipo, referencia_id);

-- ============================================================================
-- TALLER DE REPARACIONES
-- ============================================================================

CREATE SEQUENCE reparaciones_folio_seq;

CREATE TABLE reparaciones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio              text NOT NULL UNIQUE DEFAULT ('R-' || lpad(nextval('reparaciones_folio_seq')::text, 6, '0')),
  cliente_id         uuid NOT NULL REFERENCES clientes(id),
  sucursal_id        uuid NOT NULL REFERENCES sucursales(id),
  equipo_marca       text,
  equipo_modelo      text,
  imei_equipo        text,
  problema_reportado text NOT NULL,
  diagnostico        text,
  estado             estado_reparacion NOT NULL DEFAULT 'recibido',
  prioridad          prioridad_reparacion NOT NULL DEFAULT 'media',
  tecnico_id         uuid REFERENCES usuarios(id),
  costo_mano_obra    numeric(12,2) NOT NULL DEFAULT 0,
  costo_refacciones  numeric(12,2) NOT NULL DEFAULT 0,
  total              numeric(12,2) NOT NULL DEFAULT 0,
  garantia_dias      integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reparaciones_estado ON reparaciones(estado);
CREATE INDEX idx_reparaciones_tecnico ON reparaciones(tecnico_id);
CREATE INDEX idx_reparaciones_cliente ON reparaciones(cliente_id);
CREATE INDEX idx_reparaciones_sucursal ON reparaciones(sucursal_id);

CREATE TABLE reparacion_refacciones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  producto_id    uuid NOT NULL REFERENCES productos(id),
  cantidad       integer NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  costo          numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_reparacion_refacciones_reparacion ON reparacion_refacciones(reparacion_id);

-- Linea de tiempo del folio (lo que se ve en el timeline del prototipo).
CREATE TABLE reparacion_historial (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  estado         estado_reparacion NOT NULL,
  nota           text,
  usuario_id     uuid REFERENCES usuarios(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reparacion_historial_reparacion ON reparacion_historial(reparacion_id);

CREATE TABLE reparacion_fotos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  url            text NOT NULL,
  etiqueta       etiqueta_foto_reparacion,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reparacion_fotos_reparacion ON reparacion_fotos(reparacion_id);

CREATE TABLE notificaciones_cliente (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
  canal          canal_notificacion_cliente NOT NULL,
  mensaje        text NOT NULL,
  estado         estado_notificacion_cliente NOT NULL DEFAULT 'pendiente',
  enviado_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notificaciones_cliente_reparacion ON notificaciones_cliente(reparacion_id);

-- ============================================================================
-- COMMUNITY MANAGER Y AUTOMATIZACION IA
-- ============================================================================

CREATE TABLE publicaciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id       uuid REFERENCES productos(id),
  plataforma        plataforma_publicacion NOT NULL,
  contenido_texto   text,
  imagen_url        text,
  estado            estado_publicacion NOT NULL DEFAULT 'borrador',
  fecha_programada  timestamptz,
  creado_por        uuid REFERENCES usuarios(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_publicaciones_estado ON publicaciones(estado);
CREATE INDEX idx_publicaciones_fecha ON publicaciones(fecha_programada);

CREATE TABLE promociones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         text NOT NULL,
  descripcion    text,
  descuento_pct  numeric(5,2) CHECK (descuento_pct >= 0 AND descuento_pct <= 100),
  producto_id    uuid REFERENCES productos(id),
  categoria_id   uuid REFERENCES categorias(id),
  fecha_inicio   date NOT NULL,
  fecha_fin      date NOT NULL,
  activo         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (fecha_fin >= fecha_inicio)
);
CREATE INDEX idx_promociones_vigencia ON promociones(fecha_inicio, fecha_fin);

CREATE TABLE conversaciones_ia (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_telefono  text NOT NULL,
  canal             canal_conversacion NOT NULL,
  cliente_id        uuid REFERENCES clientes(id),
  estado            estado_conversacion NOT NULL DEFAULT 'activa',
  sentimiento       text,
  ultima_actividad  timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversaciones_ia_telefono ON conversaciones_ia(cliente_telefono);
CREATE INDEX idx_conversaciones_ia_estado ON conversaciones_ia(estado);

CREATE TABLE mensajes_ia (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  uuid NOT NULL REFERENCES conversaciones_ia(id) ON DELETE CASCADE,
  remitente        remitente_mensaje NOT NULL,
  contenido        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mensajes_ia_conversacion ON mensajes_ia(conversacion_id);

-- ============================================================================
-- FINANZAS
-- ============================================================================

CREATE TABLE nominas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id     uuid NOT NULL REFERENCES usuarios(id),
  periodo_inicio date NOT NULL,
  periodo_fin    date NOT NULL,
  sueldo_base    numeric(12,2) NOT NULL DEFAULT 0,
  bonos          numeric(12,2) NOT NULL DEFAULT 0,
  deducciones    numeric(12,2) NOT NULL DEFAULT 0,
  total          numeric(12,2) NOT NULL DEFAULT 0,
  pagado         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (periodo_fin >= periodo_inicio)
);
CREATE INDEX idx_nominas_usuario ON nominas(usuario_id);

CREATE TABLE gastos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  uuid REFERENCES sucursales(id),
  categoria    text NOT NULL,
  monto        numeric(12,2) NOT NULL,
  descripcion  text,
  fecha        date NOT NULL DEFAULT current_date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gastos_sucursal ON gastos(sucursal_id);
CREATE INDEX idx_gastos_fecha ON gastos(fecha);

-- ============================================================================
-- NOTIFICACIONES INTERNAS (campana en el topbar)
-- ============================================================================

CREATE TABLE notificaciones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    uuid NOT NULL REFERENCES usuarios(id),
  tipo          text NOT NULL,
  mensaje       text NOT NULL,
  leido         boolean NOT NULL DEFAULT false,
  entidad_tipo  text,
  entidad_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notificaciones_usuario ON notificaciones(usuario_id, leido);

-- ============================================================================
-- CONFIGURACION (fila unica / singleton — datos editables del ticket de venta)
-- ============================================================================

CREATE TABLE configuracion_ticket (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_negocio     text NOT NULL DEFAULT 'CityPhone',
  mostrar_direccion  boolean NOT NULL DEFAULT true,
  mostrar_telefono   boolean NOT NULL DEFAULT true,
  mostrar_vendedor   boolean NOT NULL DEFAULT true,
  mostrar_cliente    boolean NOT NULL DEFAULT true,
  mensaje_pie        text NOT NULL DEFAULT '¡Gracias por tu compra!',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- TRIGGERS updated_at
-- ============================================================================

CREATE TRIGGER trg_sucursales_updated_at BEFORE UPDATE ON sucursales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_usuarios_updated_at BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_clientes_updated_at BEFORE UPDATE ON clientes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_productos_updated_at BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_inventario_updated_at BEFORE UPDATE ON inventario
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_unidades_imei_updated_at BEFORE UPDATE ON unidades_imei
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_creditos_updated_at BEFORE UPDATE ON creditos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_reparaciones_updated_at BEFORE UPDATE ON reparaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_publicaciones_updated_at BEFORE UPDATE ON publicaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_configuracion_ticket_updated_at BEFORE UPDATE ON configuracion_ticket
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
