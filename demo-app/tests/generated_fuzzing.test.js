jest.setTimeout(10000);

const request = require('supertest');
const app = require('../server');

describe('Payload Fuzzing - Input Validation', () => {
  const ENDPOINT = '/api/v1/transfer';

  test('Null amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: null });
    expect(res.status).toBe(400);
  });

  test('Negative amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: -100 });
    expect(res.status).toBe(400);
  });

  test('Zero amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: 0 });
    expect(res.status).toBe(400);
  });

  test('String amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: 'lots' });
    expect(res.status).toBe(400);
  });

  test('Missing amount field → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102' });
    expect(res.status).toBe(400);
  });

  test('Missing senderId → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ recipientId: 'usr_102', amount: 100 });
    expect(res.status).toBe(400);
  });

  test('Missing recipientId → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', amount: 100 });
    expect(res.status).toBe(400);
  });

  test('Unknown user senderId → 404', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'hacker_999', recipientId: 'usr_102', amount: 1 });
    expect(res.status).toBe(404);
  });

  test('Extremely large amount (insufficient funds or validation error) → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: 999999999 });
    expect(res.status).toBe(400);
  });

  test('SQL injection string as senderId → 400 or 404 (not 200 or 500)', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: "' OR 1=1 --", recipientId: 'usr_102', amount: 1 });
    expect([400, 404]).toContain(res.status);
  });

  test('Array as amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: [100] });
    expect(res.status).toBe(400);
  });

  test('Object as amount → 400', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ senderId: 'usr_101', recipientId: 'usr_102', amount: { $gt: 0 } });
    expect(res.status).toBe(400);
  });
});
