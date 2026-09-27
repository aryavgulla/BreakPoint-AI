const express = require('express');
const router = express.Router();
const mutex = require('async-mutex');
const validate = require('validate');

let users = {
  usr_101: { balance: 1000 },
  usr_102: { balance: 500 }
};

let executedTransfers = 0;
const mutexLock = new mutex.Mutex();

router.post('/', (req, res) => {
  const { senderId, recipientId, amount } = req.body || {};
  const validationRules = {
    senderId: { type: 'string', required: true },
    recipientId: { type: 'string', required: true },
    amount: { type: 'number', required: true, min: 0.01 }
  };
  const errors = validate(req.body, validationRules);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  if (
    !senderId || 
    !recipientId || 
    typeof senderId !== 'string' || 
    typeof recipientId !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid or missing senderId/recipientId' });
  }

  if (senderId.includes("'") || senderId.includes("--") || recipientId.includes("'") || recipientId.includes("--")) {
    return res.status(400).json({ error: 'Malicious payload detected' });
  }

  if (
    amount === undefined || 
    amount === null || 
    typeof amount !== 'number' || 
    isNaN(amount) || 
    !Number.isFinite(amount)
  ) {
    return res.status(400).json({ error: 'Invalid amount format' });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: 'Amount must be positive' });
  }

  if (!users[senderId] || !users[recipientId]) {
    return res.status(404).json({ error: 'User not found' });
  }

  mutexLock.runExclusive(() => {
    if (executedTransfers >= 1) {
      return res.status(429).json({ error: 'Too many requests: Concurrency limit reached' });
    }

    if (users[senderId].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    executedTransfers++;
    users[senderId].balance -= amount;
    users[recipientId].balance += amount;

    return res.json({ success: true });
  });
});

module.exports = router;