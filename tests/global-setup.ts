// Chạy một lần trước toàn bộ test: áp migration lên DB test (không bao giờ DB dev).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TEST_DATABASE_URL } from './helpers/test-env.js';

export default function setup(): void {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(
      `Không áp được migration lên DB test. Đã chạy "docker compose up -d postgres" chưa?\n${stderr}`,
      { cause: err },
    );
  }
}
