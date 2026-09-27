const express = require('express');
const router = express.Router();

// Vulnerable endpoint for testing
router.post('/profile', (req, res) => {
  const { username } = req.body;
  // Intentional vulnerability: no input validation
  res.json({ message: `Profile updated for ${username}` });
});

module.exports = router;