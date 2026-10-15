require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { requireAuth, soloCityPhone } = require('./src/middleware/auth');

const authRoutes = require('./src/routes/auth.routes');
const usuariosRoutes = require('./src/routes/usuarios.routes');
const sucursalesRoutes = require('./src/routes/sucursales.routes');
const productosRoutes = require('./src/routes/productos.routes');
const preciosEspecialesRoutes = require('./src/routes/preciosEspeciales.routes');
const clientesRoutes = require('./src/routes/clientes.routes');
const ventasRoutes = require('./src/routes/ventas.routes');
const cambiosRoutes = require('./src/routes/cambios.routes');
const cortesCajaRoutes = require('./src/routes/cortes_caja.routes');
const categoriasRoutes = require('./src/routes/categorias.routes');
const configuracionRoutes = require('./src/routes/configuracion.routes');
const nominasRoutes = require('./src/routes/nominas.routes');
const gastosRoutes = require('./src/routes/gastos.routes');
const finanzasRoutes = require('./src/routes/finanzas.routes');
const reparacionesRoutes = require('./src/routes/reparaciones.routes');
const solicitudesPiezaRoutes = require('./src/routes/solicitudesPieza.routes');
const revisionCostosRoutes = require('./src/routes/revisionCostos.routes');
const refaccionesRoutes = require('./src/routes/refacciones.routes');
const publicacionesRoutes = require('./src/routes/publicaciones.routes');
const promocionesRoutes = require('./src/routes/promociones.routes');
const marketplaceRoutes = require('./src/routes/marketplace.routes');
const bibliotecaRoutes = require('./src/routes/biblioteca.routes');
const proveedoresRoutes = require('./src/routes/proveedores.routes');
const filaEsperaRoutes = require('./src/routes/filaEspera.routes');
const cambiosEquipoRoutes = require('./src/routes/cambiosEquipo.routes');
const ordenesCompraRoutes = require('./src/routes/ordenesCompra.routes');
const comprasRoutes = require('./src/routes/compras.routes');
const reportesRoutes = require('./src/routes/reportes.routes');
const conversacionesRoutes = require('./src/routes/conversaciones.routes');
const comentariosRoutes = require('./src/routes/comentarios.routes');
const uploadsRoutes = require('./src/routes/uploads.routes');
const creditosRoutes = require('./src/routes/creditos.routes');
const apartadosRoutes = require('./src/routes/apartados.routes');
const busquedaRoutes = require('./src/routes/busqueda.routes');
const celularesRoutes = require('./src/routes/celulares.routes');
const aureaProductosRoutes = require('./src/routes/aureaProductos.routes');
const aureaVentasRoutes = require('./src/routes/aureaVentas.routes');
const aureaProveedoresRoutes = require('./src/routes/aureaProveedores.routes');
const aureaClientesRoutes = require('./src/routes/aureaClientes.routes');
const aureaApartadosRoutes = require('./src/routes/aureaApartados.routes');
const aureaGastosRoutes = require('./src/routes/aureaGastos.routes');
const aureaCortesCajaRoutes = require('./src/routes/aureaCortesCaja.routes');
const aureaConfiguracionRoutes = require('./src/routes/aureaConfiguracion.routes');
const aureaReportesRoutes = require('./src/routes/aureaReportes.routes');
const politicasRoutes = require('./src/routes/politicas.routes');
const negocioExternoRoutes = require('./src/routes/negocioExterno.routes');
const pendienteExternoRoutes = require('./src/routes/pendienteExterno.routes');
const pendientesAgenteRoutes = require('./src/routes/pendientesAgente.routes');
const prospectoExternoRoutes = require('./src/routes/prospectoExterno.routes');
const prospectosAgenteRoutes = require('./src/routes/prospectosAgente.routes');
const n8nRoutes = require('./src/routes/n8n.routes');
const catalogoExternoRoutes = require('./src/routes/catalogoExterno.routes');
const contactoExternoRoutes = require('./src/routes/contactoExterno.routes');
const reparacionExternaRoutes = require('./src/routes/reparacionExterna.routes');
const apartadoExternoRoutes = require('./src/routes/apartadoExterno.routes');
const opcionesEquipoRoutes = require('./src/routes/opcionesEquipo.routes');
const vinculosCelularRoutes = require('./src/routes/vinculosCelular.routes');

const app = express();

// Render pone la app detras de un solo proxy reverso, que manda la IP real
// del cliente en X-Forwarded-For. Sin esto, Express no confia en ese header
// (trust proxy = false por defecto) y express-rate-limit truena en cada
// petición (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) — ademas de que, sin esto,
// el rate limit terminaria limitando por la IP del proxy de Render, no por
// cliente real. "1" = confiar exactamente un salto de proxy, que es la
// topología real de Render (no usar "true", que confía en cualquier salto).
app.set('trust proxy', 1);

// Por defecto acepta cualquier origen (como antes) para no romper nada en
// producción; si se define ALLOWED_ORIGINS (lista separada por comas) en el
// entorno, solo esos orígenes podrán llamar a la API desde un navegador.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));

// Limite general de peticiones por IP, como defensa basica contra abuso o
// scripts descontrolados. El limite de /auth/login es aparte y mas estricto.
// Todos los equipos de una sucursal salen por la MISMA IP, y las pantallas que se actualizan solas (Panel, Recepcion / Entrega, folio abierto)
// piden datos cada 15-30 s: con 600 por 15 min (40 por minuto) varios equipos abiertos a la vez podian agotarlo (1000 = unas 66 por minuto). Se puede ajustar con
// RATE_LIMIT_GENERAL (peticiones por 15 minutos) en Render.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_GENERAL) || 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Limite subido de 100kb (default) a 15mb: las automatizaciones de IA via
// n8n mandan imagenes/audio en base64 dentro del JSON (ver n8n.routes.js),
// que facilmente pasan de 1-3MB. Tiene que subirse aqui, en el
// express.json() global — uno con limite mas alto puesto solo en el router
// de n8n no sirve de nada porque este ya habria rechazado el body antes de
// que la petición llegue ahi.
app.use(express.json({ limit: '15mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ name: 'CityPhone SGI API' });
});

// Las rutas de CityPhone (todas menos auth, usuarios, uploads, vinculos-celular, n8n, las de Áurea y las que llama n8n con su secreto) solo
// las abre alguien de CityPhone (o el dueño): un usuario de Áurea no puede leer ni operar sus datos. Ver soloCityPhone.
const deCityPhone = [requireAuth, soloCityPhone];

app.use('/auth', authRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/sucursales', ...deCityPhone, sucursalesRoutes);
app.use('/productos', ...deCityPhone, productosRoutes);
app.use('/precios-especiales', ...deCityPhone, preciosEspecialesRoutes);
app.use('/clientes', ...deCityPhone, clientesRoutes);
app.use('/ventas', ...deCityPhone, ventasRoutes);
app.use('/cambios', ...deCityPhone, cambiosRoutes);
app.use('/cortes-caja', ...deCityPhone, cortesCajaRoutes);
app.use('/categorias', ...deCityPhone, categoriasRoutes);
app.use('/configuracion-ticket', ...deCityPhone, configuracionRoutes);
app.use('/nominas', ...deCityPhone, nominasRoutes);
app.use('/gastos', ...deCityPhone, gastosRoutes);
app.use('/finanzas', ...deCityPhone, finanzasRoutes);
app.use('/reparaciones', ...deCityPhone, reparacionesRoutes);
app.use('/solicitudes-pieza', ...deCityPhone, solicitudesPiezaRoutes);
app.use('/revision-costos', ...deCityPhone, revisionCostosRoutes);
app.use('/refacciones', ...deCityPhone, refaccionesRoutes);
app.use('/publicaciones', ...deCityPhone, publicacionesRoutes);
app.use('/promociones', ...deCityPhone, promocionesRoutes);
app.use('/marketplace', ...deCityPhone, marketplaceRoutes);
app.use('/biblioteca', ...deCityPhone, bibliotecaRoutes);
app.use('/proveedores', ...deCityPhone, proveedoresRoutes);
app.use('/fila-espera', ...deCityPhone, filaEsperaRoutes);
app.use('/cambios-equipo', ...deCityPhone, cambiosEquipoRoutes);
app.use('/ordenes-compra', ...deCityPhone, ordenesCompraRoutes);
app.use('/compras', ...deCityPhone, comprasRoutes);
app.use('/reportes', ...deCityPhone, reportesRoutes);
app.use('/conversaciones', ...deCityPhone, conversacionesRoutes);
app.use('/comentarios', ...deCityPhone, comentariosRoutes);
app.use('/uploads', uploadsRoutes);
app.use('/creditos', ...deCityPhone, creditosRoutes);
app.use('/apartados', ...deCityPhone, apartadosRoutes);
app.use('/busqueda', ...deCityPhone, busquedaRoutes);
app.use('/celulares-vendidos', ...deCityPhone, celularesRoutes);
app.use('/aurea/productos', aureaProductosRoutes);
app.use('/aurea/ventas', aureaVentasRoutes);
app.use('/aurea/proveedores', aureaProveedoresRoutes);
app.use('/aurea/clientes', aureaClientesRoutes);
app.use('/aurea/apartados', aureaApartadosRoutes);
app.use('/aurea/gastos', aureaGastosRoutes);
app.use('/aurea/cortes-caja', aureaCortesCajaRoutes);
app.use('/aurea/configuracion-ticket', aureaConfiguracionRoutes);
app.use('/aurea/reportes', aureaReportesRoutes);
app.use('/politicas', ...deCityPhone, politicasRoutes);
app.use('/pendientes-agente', ...deCityPhone, pendientesAgenteRoutes);
app.use('/prospectos-agente', ...deCityPhone, prospectosAgenteRoutes);
app.use('/n8n', n8nRoutes);
app.use('/catalogo-externo', catalogoExternoRoutes);
app.use('/contacto-externo', contactoExternoRoutes);
app.use('/negocio-externo', negocioExternoRoutes);
app.use('/pendiente-externo', pendienteExternoRoutes);
app.use('/prospecto-externo', prospectoExternoRoutes);
app.use('/reparacion-externa', reparacionExternaRoutes);
app.use('/apartado-externo', apartadoExternoRoutes);
app.use('/opciones-equipo', ...deCityPhone, opcionesEquipoRoutes);
app.use('/vinculos-celular', vinculosCelularRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CityAPI escuchando en el puerto ${port}`);
});
