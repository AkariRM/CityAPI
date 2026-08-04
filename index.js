const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ name: 'CityPhone SGI API' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CityAPI escuchando en el puerto ${port}`);
});
