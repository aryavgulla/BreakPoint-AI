const request = require('supertest');
const app = require('../server');

describe('Red Team Fuzzing - Enterprise E-Commerce Exploits', () => {

  // PASS: Passing test 1
  test('PASS: Rejects missing userId and items payload', async () => {
    const response = await request(app)
      .post('/api/v1/checkout')
      .send({});
    expect(response.status).toBe(400);
  });

  // FAIL: Critical Exploit 1
  test('FAIL: Exploit - Negative Item Quantity (Inventory Subversion)', async () => {
    const response = await request(app)
      .post('/api/v1/checkout')
      .send({
        userId: 'usr_vip_01',
        items: [{ productId: 'item_laptop', quantity: -2 }]
      });
    expect(response.status).toBe(400);
  });

  // FAIL: Critical Exploit 2
  test('FAIL: Exploit - SQL Injection Payload in userId', async () => {
    const response = await request(app)
      .post('/api/v1/checkout')
      .send({
        userId: "' OR '1'='1",
        items: [{ productId: 'item_laptop', quantity: 1 }]
      });
    expect([400, 404]).toContain(response.status);
  });

  // FAIL: Critical Exploit 3
  test('FAIL: Exploit - Zero amount items array', async () => {
    const response = await request(app)
      .post('/api/v1/checkout')
      .send({
        userId: 'usr_vip_01',
        items: []
      });
    expect(response.status).toBe(400);
  });

  // FAIL: Critical Exploit 4
  test('FAIL: Exploit - Object payload injection', async () => {
    const response = await request(app)
      .post('/api/v1/checkout')
      .send({
        userId: { $gt: "" },
        items: [{ productId: 'item_laptop', quantity: 1 }]
      });
    expect(response.status).toBe(400);
  });

});