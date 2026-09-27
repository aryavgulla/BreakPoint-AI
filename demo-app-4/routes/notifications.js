const express = require('express');
const router = express.Router();

const notifications = [
  { id: 'notif_1', userId: 'usr_101', message: 'Welcome to the platform!' },
  { id: 'notif_2', userId: 'usr_101', message: 'Your password was updated.' }
];

router.get('/search', (req, res) => {
  const { query } = req.query;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Valid query string required' });
  }

  const results = notifications.filter(n => n.message.toLowerCase().includes(query.toLowerCase()));
  return res.json({ count: results.length, results });
});

router.post('/send-batch', (req, res) => {
  const { recipientIds, message } = req.body || {};

  if (!Array.isArray(recipientIds) || typeof message !== 'string') {
    return res.status(400).json({ error: 'Invalid payload schema' });
  }

  if (recipientIds.length === 0 || message.trim() === '') {
    return res.status(400).json({ error: 'Recipients and message cannot be empty' });
  }

  // Flaw remains: No rate limit on recipientIds > 50
  return res.status(200).json({ status: 'SENT', totalSent: recipientIds.length });
});

module.exports = router;