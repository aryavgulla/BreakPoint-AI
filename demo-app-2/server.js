const express = require('express');
const app = express();
app.use(express.json());

app.use('/api/v1/transfer', require('./routes/transfer'));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`demo-app-2 running on port ${PORT}`));
}

module.exports = app;