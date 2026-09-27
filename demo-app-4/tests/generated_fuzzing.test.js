const request = require('supertest');
const app = require('../server');

describe('CI/CD Security Suite - Compliance & Gating', () => {

  test('PASS: Rejects empty search query', async () => {
    const res = await request(app).get('/api/v1/notifications/search');
    expect(res.status).toBe(400);
  });

  test('PASS: Rejects non-string search query object', async () => {
    const res = await request(app).get('/api/v1/notifications/search?query[$gt]=');
    expect(res.status).toBe(400);
  });

  test('PASS: Accepts valid notification batch payload', async () => {
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: ['usr_101', 'usr_102'], message: 'System alert' });
    expect(res.status).toBe(200);
  });

  test('PASS: Rejects non-array recipientIds', async () => {
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: 'usr_101', message: 'System alert' });
    expect(res.status).toBe(400);
  });

  test('PASS: Rejects empty recipient list', async () => {
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: [], message: 'System alert' });
    expect(res.status).toBe(400);
  });

  test('PASS: Rejects non-string message body', async () => {
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: ['usr_101'], message: 12345 });
    expect(res.status).toBe(400);
  });

  test('PASS: Rejects empty whitespace message body', async () => {
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: ['usr_101'], message: '   ' });
    expect(res.status).toBe(400);
  });

  // --- FAILING TEST (Rate Limit Missing) ---
  test('FAIL: Large batch without rate-limit gating (Resource Exhaustion)', async () => {
    const largeBatch = Array.from({ length: 100 }, (_, i) => `usr_${i}`);
    const res = await request(app)
      .post('/api/v1/notifications/send-batch')
      .send({ recipientIds: largeBatch, message: 'Mass alert' });

    // Expecting rate limit rejection
    expect(res.status).toBe(429);
  });

});