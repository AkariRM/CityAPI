require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

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
const publicacionesRoutes = require('./src/routes/publicaciones.routes');
const promocionesRoutes = require('./src/routes/promociones.routes');
const marketplaceRoutes = require('./src/routes/marketplace.routes');
const bibliotecaRoutes = require('./src/routes/biblioteca.routes');
const proveedoresRoutes = require('./src/routes/proveedores.routes');
const filaEsperaRoutes = require('./src/routes/filaEspera.routes');
const cambiosEquipoRoutes = require('./src/routes/cambiosEquipo.routes');
const ordenesCompraRoutes = require('./src/routes/ordenesCompra.routes');
const reportesRoutes = require('./src/routes/reportes.routes');
const conversacionesRoutes = require('./src/routes/conversaciones.routes');
const comentariosRoutes = require('./src/routes/comentarios.routes');
const uploadsRoutes = require('./src/routes/uploads.routes');
const creditosRoutes = require('./src/routes/creditos.routes');
const apartadosRoutes = require('./src/routes/apartados.routes');
const busquedaRoutes = require('./src/routes/busqueda.routes');
const celularesRoutes = require('./src/routes/celulares.routes');

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
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ name: 'CityPhone SGI API' });
});

app.use('/auth', authRoutes);
app.use('/usuarios', usuariosRoutes);
app.use('/sucursales', sucursalesRoutes);
app.use('/productos', productosRoutes);
app.use('/precios-especiales', preciosEspecialesRoutes);
app.use('/clientes', clientesRoutes);
app.use('/ventas', ventasRoutes);
app.use('/cambios', cambiosRoutes);
app.use('/cortes-caja', cortesCajaRoutes);
app.use('/categorias', categoriasRoutes);
app.use('/configuracion-ticket', configuracionRoutes);
app.use('/nominas', nominasRoutes);
app.use('/gastos', gastosRoutes);
app.use('/finanzas', finanzasRoutes);
app.use('/reparaciones', reparacionesRoutes);
app.use('/publicaciones', publicacionesRoutes);
app.use('/promociones', promocionesRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/biblioteca', bibliotecaRoutes);
app.use('/proveedores', proveedoresRoutes);
app.use('/fila-espera', filaEsperaRoutes);
app.use('/cambios-equipo', cambiosEquipoRoutes);
app.use('/ordenes-compra', ordenesCompraRoutes);
app.use('/reportes', reportesRoutes);
app.use('/conversaciones', conversacionesRoutes);
app.use('/comentarios', comentariosRoutes);
app.use('/uploads', uploadsRoutes);
app.use('/creditos', creditosRoutes);
app.use('/apartados', apartadosRoutes);
app.use('/busqueda', busquedaRoutes);
app.use('/celulares-vendidos', celularesRoutes);

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
