import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

describe('GET /api/v1/health', () => {
  const { app, prisma } = createTestApp();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('trả 200 khi Postgres kết nối được', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('trả 503 và không lộ chi tiết lỗi khi DB không kết nối được', async () => {
    const deadDb = new PrismaClient({ datasourceUrl: 'postgresql://pgs:wrong@127.0.0.1:1/none' });
    const { app: degraded } = createTestApp({ prisma: deadDb });
    const res = await request(degraded).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', checks: { database: 'down' } });
    // Client chưa từng kết nối được: $disconnect cũng ném lỗi khởi tạo, bỏ qua.
    await deadDb.$disconnect().catch(() => undefined);
  });

  it('giữ correlation id hợp lệ do client gửi', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Correlation-Id', 'abc-123');
    expect(res.headers['x-correlation-id']).toBe('abc-123');
  });
});

describe('route không tồn tại', () => {
  const { app, prisma } = createTestApp();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('trả 404 theo định dạng lỗi chuẩn', async () => {
    const res = await request(app).get('/api/v1/khong-co');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) as string } });
  });

  it('JSON hỏng trả 400 VALIDATION_ERROR, không lộ stack', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(JSON.stringify(res.body)).not.toMatch(/at .+\.(js|ts):\d+/);
  });
});
