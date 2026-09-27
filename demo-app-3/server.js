const express = require('express');
const app = express();

app.use(express.json());
app.use('/api/v1', require('./routes/checkout'));

const PORT = process.env.PORT || 3003;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`demo-app-3 (Enterprise E-Commerce) live on port ${PORT}`));
}

module.exports = app;