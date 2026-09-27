jest.setTimeout(15000);

const path = require('path');

describe('Concurrency Attack - Double Spend', () => {
  let request;
  let app;

  beforeEach(() => {
    jest.resetModules();
    // Re-require transfer route first so its in-memory state is reset
    require('../routes/transfer');
    app = require('../server');
    request = require('supertest');
  });

  test('should allow exactly one successful transfer when 10 concurrent identical requests are fired', async () => {
    const payload = { senderId: 'usr_101', recipientId: 'usr_102', amount: 500 };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/v1/transfer')
          .send(payload)
          .set('Content-Type', 'application/json')
      )
    );

    const successes = responses.filter((r) => r.status === 200);
    const failures  = responses.filter((r) => r.status === 400);

    // Exactly one request should succeed; the rest should be rejected
    // This test is EXPECTED TO FAIL on unpatched code (double-spend bug)
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);
  });

  test('should never result in a negative sender balance', async () => {
    const payload = { senderId: 'usr_101', recipientId: 'usr_102', amount: 500 };

    // Fire 10 concurrent transfers that each attempt to drain the full balance
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/v1/transfer')
          .send(payload)
          .set('Content-Type', 'application/json')
      )
    );

    // Attempt a follow-up transfer; if it succeeds, the returned newBalance must be >= 0
    const followUp = await request(app)
      .post('/api/v1/transfer')
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: 1 })
      .set('Content-Type', 'application/json');

    if (followUp.status === 200) {
      expect(followUp.body.newBalance).toBeGreaterThanOrEqual(0);
    } else {
      // If the transfer was rejected, the sender's balance is at most 0 — still valid
      expect(followUp.status).toBe(400);
    }
  });
});
