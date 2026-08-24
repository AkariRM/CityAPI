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

-- 'dueño' es superior a 'admin': ve/opera todas las empresas siempre (a
-- diferencia de 'admin', que queda asignado a una sola vía usuarios.empresa_id).
-- 'pto' (Punto de Venta/Operador) es exclusivo de Áurea — vendedor+técnico
-- de CityPhone no aplican ahí, es un rol operativo mucho más simple.
CREATE TYPE rol_usuario AS ENUM ('dueño', 'admin', 'vendedor', 'tecnico', 'community_manager', 'pto');
CREATE TYPE metodo_pago AS ENUM ('efectivo', 'tarjeta', 'credito');
CREATE TYPE estado_venta AS ENUM ('completada', 'cancelada');
CREATE TYPE tipo_producto AS ENUM ('nuevo', 'usado', 'accesorio', 'servicio');
CREATE TYPE estado_unidad_imei AS ENUM ('disponible', 'apartado', 'vendido', 'en_garantia', 'en_reparacion', 'baja');
CREATE TYPE estado_apartado AS ENUM ('activo', 'completado', 'cancelado');
CREATE TYPE tipo_movimiento_inventario AS ENUM ('entrada', 'salida', 'ajuste', 'traspaso');
CREATE TYPE estado_credito AS ENUM ('activo', 'pagado', 'vencido', 'cancelado');
CREATE TYPE estado_reparacion AS ENUM ('recibido', 'diagnostico', 'reparacion', 'listo', 'entregado');
CREATE TYPE prioridad_reparacion AS ENUM ('baja', 'media', 'alta');
CREATE TYPE etiqueta_foto_reparacion AS ENUM ('antes', 'despues', 'diagnostico');
CREATE TYPE canal_notificacion_cliente AS ENUM ('whatsapp', 'sms');
CREATE TYPE estado_notificacion_cliente AS ENUM ('pendiente', 'enviado', 'fallido');
CREATE TYPE plataforma_publicacion AS ENUM ('instagram', 'facebook');
CREATE TYPE estado_publicacion AS ENUM ('pendiente', 'programado', 'rechazado', 'publicado');
CREATE TYPE tipo_contenido_publicacion AS ENUM ('reel', 'carrusel', 'historia', 'post_estatico', 'video');
CREATE TYPE canal_conversacion AS ENUM ('whatsapp', 'instagram');
CREATE TYPE estado_conversacion AS ENUM ('activa', 'cerrada', 'escalada');
CREATE TYPE remitente_mensaje AS ENUM ('cliente', 'ia', 'humano');
CREATE TYPE grado_cambio_equipo AS ENUM ('A', 'B', 'C', 'D', 'otro');
CREATE TYPE estado_cambio_equipo AS ENUM ('evaluando', 'aceptado', 'rechazado', 'completado');
CREATE TYPE estado_orden_compra AS ENUM ('pendiente', 'recibida');
CREATE TYPE estado_comentario AS ENUM ('pendiente', 'respondido', 'descartado');

-- ============================================================================
-- NUCLEO: empresas, sucursales, usuarios, sesiones, auditoria
-- ============================================================================

-- CityCorp: raiz multiempresa. CityPhone y Aurea comparten este mismo
-- backend/DB pero cada quien con sus propias tablas de negocio (ver mas
-- abajo "AUREA") — empresas solo sirve para el login/permisos, no hay
-- ninguna FK desde productos/ventas/etc. de CityPhone hacia aqui.
CREATE TABLE empresas (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug    text NOT NULL UNIQUE,
  nombre  text NOT NULL,
  activo  boolean NOT NULL DEFAULT true
);
-- Datos de sistema, no de demo: sin estas 2 filas no hay login posible.
INSERT INTO empresas (slug, nombre) VALUES ('cityphone', 'CityPhone'), ('aurea', 'Áurea');

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
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                text NOT NULL,
  telefono              text,
  email                 text UNIQUE,
  rol                   rol_usuario NOT NULL,
  -- NULL solo para 'dueño' (ve todas las empresas); obligatorio para
  -- cualquier otro rol — a que empresa pertenece esta cuenta.
  empresa_id            uuid REFERENCES empresas(id),
  -- Solo se usa para 'dueño': recuerda la ultima empresa activa para que
  -- la vea de entrada la proxima vez que inicie sesion, en cualquier
  -- dispositivo (a diferencia de la sucursal, que se fija por dispositivo).
  empresa_preferida_id  uuid REFERENCES empresas(id),
  sucursal_id           uuid REFERENCES sucursales(id),
  pin_hash              text NOT NULL,
  intentos_fallidos     smallint NOT NULL DEFAULT 0,
  bloqueado_hasta       timestamptz,
  avatar_color          text,
  activo                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usuarios_rol ON usuarios(rol);
CREATE INDEX idx_usuarios_sucursal ON usuarios(sucursal_id);
CREATE INDEX idx_usuarios_empresa ON usuarios(empresa_id);

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
  ram            text,
  almacenamiento text,
  procesador     text,
  usa_imei       boolean NOT NULL DEFAULT true,
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
  stock_apartado  integer NOT NULL DEFAULT 0 CHECK (stock_apartado >= 0),
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
  imei               text UNIQUE,
  condicion          text,
  costo_adquisicion  numeric(12,2),
  estado             estado_unidad_imei NOT NULL DEFAULT 'disponible',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_unidades_imei_producto ON unidades_imei(producto_id, sucursal_id);
CREATE INDEX idx_unidades_imei_estado ON unidades_imei(estado);

-- Apartados: reservar N unidades de un producto (o una unidad IMEI puntual)
-- para un cliente, con un anticipo opcional. Mientras esta 'activo', esa
-- cantidad se resta de lo "disponible para vender" via inventario.stock_apartado,
-- pero sigue contando en stock_cantidad (el producto no ha salido de la
-- tienda). Al completarse SI sale de la tienda: se libera el apartado Y se
-- descuenta stock_cantidad — sin generar una venta formal (el cobro, si
-- faltaba algo, ya se registro como abono antes de completar).
CREATE SEQUENCE apartados_folio_seq;
CREATE TABLE apartados (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio           text NOT NULL UNIQUE DEFAULT ('AP-' || lpad(nextval('apartados_folio_seq')::text, 6, '0')),
  cliente_id      uuid NOT NULL REFERENCES clientes(id),
  sucursal_id     uuid NOT NULL REFERENCES sucursales(id),
  producto_id     uuid NOT NULL REFERENCES productos(id),
  unidad_imei_id  uuid REFERENCES unidades_imei(id),
  cantidad        integer NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio_total    numeric(12,2) NOT NULL,
  monto_abonado   numeric(12,2) NOT NULL DEFAULT 0,
  estado          estado_apartado NOT NULL DEFAULT 'activo',
  usuario_id      uuid NOT NULL REFERENCES usuarios(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_apartados_cliente ON apartados(cliente_id);
CREATE INDEX idx_apartados_producto ON apartados(producto_id, sucursal_id);
CREATE INDEX idx_apartados_estado ON apartados(estado);

CREATE TABLE apartado_abonos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apartado_id   uuid NOT NULL REFERENCES apartados(id),
  monto         numeric(12,2) NOT NULL,
  metodo        metodo_pago NOT NULL,
  usuario_id    uuid NOT NULL REFERENCES usuarios(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_apartado_abonos_apartado ON apartado_abonos(apartado_id);

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

CREATE TABLE ordenes_compra (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id  uuid NOT NULL REFERENCES proveedores(id),
  producto_id   uuid NOT NULL REFERENCES productos(id),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  cantidad      integer NOT NULL CHECK (cantidad > 0),
  estado        estado_orden_compra NOT NULL DEFAULT 'pendiente',
  creado_por    uuid REFERENCES usuarios(id),
  recibido_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ordenes_compra_proveedor ON ordenes_compra(proveedor_id);
CREATE INDEX idx_ordenes_compra_estado ON ordenes_compra(estado);

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
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_original_id         uuid NOT NULL REFERENCES ventas(id),
  producto_devuelto_id      uuid NOT NULL REFERENCES productos(id),
  producto_nuevo_id         uuid REFERENCES productos(id),
  -- Cuando el cambio es de un celular con IMEI, guarda la unidad exacta que
  -- se devolvio y la que se entrego (si aplica), para poder rastrear el
  -- reemplazo en el registro de garantias. Opcionales: un cambio de
  -- accesorio/producto sin IMEI no las usa.
  unidad_imei_devuelta_id   uuid REFERENCES unidades_imei(id),
  unidad_imei_nueva_id      uuid REFERENCES unidades_imei(id),
  diferencia                numeric(12,2) NOT NULL DEFAULT 0,
  motivo                    text,
  usuario_id                uuid NOT NULL REFERENCES usuarios(id),
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cambios_venta ON cambios(venta_original_id);

-- Cambio de equipo por dinero (trade-in): evaluacion de un equipo usado que
-- el cliente entrega a cambio de credito, distinto de "cambios" (devolucion
-- o cambio de un producto ya comprado en tienda).
CREATE TABLE cambios_equipo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id       uuid NOT NULL REFERENCES sucursales(id),
  cliente_id        uuid REFERENCES clientes(id),
  cliente_nombre    text NOT NULL,
  equipo_modelo     text NOT NULL,
  grado             grado_cambio_equipo NOT NULL,
  grado_detalle     text,
  bateria_pct       integer,
  pantalla_ok       boolean NOT NULL DEFAULT true,
  cuerpo_ok         boolean NOT NULL DEFAULT true,
  camaras_ok        boolean NOT NULL DEFAULT true,
  botones_ok        boolean NOT NULL DEFAULT true,
  valor_referencia  numeric(12,2) NOT NULL DEFAULT 0,
  valor_ofrecido    numeric(12,2) NOT NULL DEFAULT 0,
  estado            estado_cambio_equipo NOT NULL DEFAULT 'evaluando',
  producto_id       uuid REFERENCES productos(id),
  usuario_id        uuid REFERENCES usuarios(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cambios_equipo_sucursal ON cambios_equipo(sucursal_id, estado);

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
  tipo_contenido    tipo_contenido_publicacion,
  hook              text,
  contenido_texto   text,
  cta               text,
  hashtags          text[],
  imagen_url        text,
  estado            estado_publicacion NOT NULL DEFAULT 'pendiente',
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

-- promocion_id se agrega hasta aqui porque la tabla promociones se define
-- despues de publicaciones.
ALTER TABLE publicaciones ADD COLUMN promocion_id uuid REFERENCES promociones(id);

CREATE TABLE marketplace_listados (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id   uuid NOT NULL REFERENCES productos(id),
  precio        numeric(12,2) NOT NULL,
  activa        boolean NOT NULL DEFAULT true,
  vendido       boolean NOT NULL DEFAULT false,
  creado_por    uuid REFERENCES usuarios(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketplace_listados_activa ON marketplace_listados(activa, vendido);

CREATE TABLE comentarios_redes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plataforma      plataforma_publicacion NOT NULL,
  publicacion_id  uuid REFERENCES publicaciones(id),
  autor_nombre    text NOT NULL,
  contenido       text NOT NULL,
  estado          estado_comentario NOT NULL DEFAULT 'pendiente',
  respuesta       text,
  respondido_por  uuid REFERENCES usuarios(id),
  respondido_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_comentarios_redes_estado ON comentarios_redes(estado);

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

-- "Salida de caja": dinero que sale de la caja física, de dos tipos.
-- 'gasto' es un costo real del negocio y SI cuenta en Finanzas/Utilidades
-- (calcularResumenFinanciero solo suma tipo='gasto'). 'retiro' es solo un
-- resguardo (ej. mover el efectivo de una venta grande a la caja fuerte) —
-- resta de "efectivo esperado" en el corte de caja igual que un gasto, pero
-- NO es un costo del negocio, asi que no se cuenta como gasto en ningun
-- reporte financiero.
CREATE TABLE gastos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  uuid REFERENCES sucursales(id),
  usuario_id   uuid REFERENCES usuarios(id),
  tipo         text NOT NULL DEFAULT 'gasto' CHECK (tipo IN ('gasto', 'retiro')),
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
-- FILA DE ESPERA (mostrador)
-- ============================================================================

CREATE TABLE fila_espera (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id   uuid NOT NULL REFERENCES sucursales(id),
  nombre        text NOT NULL,
  motivo        text,
  atendido      boolean NOT NULL DEFAULT false,
  atendido_por  uuid REFERENCES usuarios(id),
  atendido_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fila_espera_sucursal ON fila_espera(sucursal_id, atendido);

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
-- AUREA (segunda empresa de CityCorp — tienda de maquillaje/beauty/perfumes)
-- Fase 1 deliberadamente minima: solo catalogo y ventas, nada de clientes,
-- creditos, apartados, cambios, corte de caja ni sucursales todavia. Tablas
-- totalmente separadas de las de CityPhone (ninguna FK cruzada) a proposito.
-- ============================================================================

CREATE TABLE aurea_productos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          text NOT NULL,
  categoria       text,
  precio_venta    numeric(12,2) NOT NULL,
  costo           numeric(12,2) NOT NULL DEFAULT 0,
  stock_cantidad  integer NOT NULL DEFAULT 0,
  imagen_url      text,
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_aurea_productos_activo ON aurea_productos(activo);

CREATE SEQUENCE aurea_ventas_folio_seq;
CREATE TABLE aurea_ventas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio        text NOT NULL UNIQUE DEFAULT ('AU-' || lpad(nextval('aurea_ventas_folio_seq')::text, 6, '0')),
  usuario_id   uuid NOT NULL REFERENCES usuarios(id),
  metodo_pago  metodo_pago NOT NULL,
  subtotal     numeric(12,2) NOT NULL,
  total        numeric(12,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_aurea_ventas_usuario ON aurea_ventas(usuario_id);

CREATE TABLE aurea_venta_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id         uuid NOT NULL REFERENCES aurea_ventas(id) ON DELETE CASCADE,
  producto_id      uuid NOT NULL REFERENCES aurea_productos(id),
  cantidad         integer NOT NULL CHECK (cantidad > 0),
  precio_unitario  numeric(12,2) NOT NULL,
  subtotal         numeric(12,2) NOT NULL
);
CREATE INDEX idx_aurea_venta_items_venta ON aurea_venta_items(venta_id);

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
CREATE TRIGGER trg_apartados_updated_at BEFORE UPDATE ON apartados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_creditos_updated_at BEFORE UPDATE ON creditos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_reparaciones_updated_at BEFORE UPDATE ON reparaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cambios_equipo_updated_at BEFORE UPDATE ON cambios_equipo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_publicaciones_updated_at BEFORE UPDATE ON publicaciones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_marketplace_listados_updated_at BEFORE UPDATE ON marketplace_listados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_configuracion_ticket_updated_at BEFORE UPDATE ON configuracion_ticket
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_aurea_productos_updated_at BEFORE UPDATE ON aurea_productos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
