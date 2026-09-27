const express = require('express');
const transferRoute = require('./routes/transfer');

const app = express();
app.use(express.json());

app.use('/api/v1', transferRoute);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Target App] Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;