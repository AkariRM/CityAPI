require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth.routes');
const usuariosRoutes = require('./src/routes/usuarios.routes');
const sucursalesRoutes = require('./src/routes/sucursales.routes');
const productosRoutes = require('./src/routes/productos.routes');
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

const app = express();
app.use(cors());
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
