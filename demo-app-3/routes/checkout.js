const express = require('express');
const router = express.Router();

const storeDB = {
  users: {
    usr_vip_01: { walletBalance: 100 }
  },
  inventory: {
    item_laptop: { price: 500 }
  }
};

router.post('/checkout', (req, res) => {
  const { userId, items } = req.body || {};

  // PASSING CHECK: Basic payload presence check (returns 400 if missing)
  if (!userId || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Missing required checkout fields' });
  }

  const user = storeDB.users[userId];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  let totalCost = 0;

  // VULNERABLE LOOP: Allows negative quantities to bypass stock & add balance
  for (const cartItem of items) {
    const product = storeDB.inventory[cartItem.productId];
    if (product) {
      totalCost += product.price * cartItem.quantity;
    }
  }

  user.walletBalance -= totalCost;

  return res.status(200).json({
    status: 'ORDER_PROCESSED',
    totalCharged: totalCost,
    remainingWallet: user.walletBalance
  });
});

module.exports = router;