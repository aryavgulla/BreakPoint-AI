const express = require('express');
const app = express();

app.use(express.json());
app.use('/api/v1/notifications', require('./routes/notifications'));

const PORT = process.env.PORT || 3004;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`demo-app-4 (Notifications) running on port ${PORT}`));
}

module.exports = app;