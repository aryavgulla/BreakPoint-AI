const express = require('express');
const router = express.Router();

let accounts = {
  "usr_101": { balance: 500 },
  "usr_102": { balance: 100 }
};

// Per-sender mutex: prevents concurrent requests from the same sender racing
// through the balance check before the debit lands (double-spend fix).
const locks = new Set();
const recipientLocks = new Set();

router.post('/transfer', async (req, res) => {
  const { senderId, recipientId, amount } = req.body;

  // FIX 1: Validate required fields are present
  if (senderId === undefined || senderId === null ||
      recipientId === undefined || recipientId === null ||
      amount === undefined || amount === null) {
    return res.status(400).json({ error: "Missing required fields: senderId, recipientId, amount" });
  }

  // FIX 2: Validate amount is a finite number > 0
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount: must be a positive number" });
  }

  // FIX 3: Validate senderId and recipientId are strings
  if (typeof senderId !== 'string' || typeof recipientId !== 'string') {
    return res.status(400).json({ error: "Invalid senderId or recipientId: must be strings" });
  }

  const sender = accounts[senderId];
  const recipient = accounts[recipientId];

  if (!sender || !recipient) {
    if (!sender) {
      return res.status(404).json({ error: `Sender user '${senderId}' not found` });
    } else {
      return res.status(404).json({ error: `Recipient user '${recipientId}' not found` });
    }
  }

  // FIX 4: Acquire a per-sender lock to prevent concurrent double-spend
  if (locks.has(senderId)) {
    return res.status(400).json({ error: "Transfer already in progress for this sender" });
  }
  locks.add(senderId);
  if (recipientLocks.has(recipientId)) {
    return res.status(400).json({ error: "Transfer already in progress for this recipient" });
  }
  recipientLocks.add(recipientId);

  try {
    if (sender.balance < amount) {
      return res.status(400).json({ error: "Insufficient funds" });
    }

    // Simulated async DB delay (now protected by the lock above)
    await new Promise(resolve => setTimeout(resolve, 50));

    sender.balance -= amount;
    recipient.balance += amount;

    return res.status(200).json({
      success: true,
      newBalance: sender.balance
    });
  } finally {
    locks.delete(senderId);
    recipientLocks.delete(recipientId);
  }
});

module.exports = router;