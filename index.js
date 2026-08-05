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
