// Hai project:
// - main (npm test): mọi test, trừ test bảo mật có ID trong tests/security/open-findings.json.
// - security (npm run test:security): chỉ tests/security, gồm cả các ID còn mở.
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const OPEN_FINDINGS = 'tests/security/open-findings.json';

function openFindingExcludes(): string[] {
  if (!existsSync(OPEN_FINDINGS)) return [];
  const list = JSON.parse(readFileSync(OPEN_FINDINGS, 'utf8')) as { id: string }[];
  return list.map((f) => `tests/security/${f.id}.test.ts`);
}

export default defineConfig({
  test: {
    setupFiles: ['tests/setup-env.ts'],
    globalSetup: ['tests/global-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', ...openFindingExcludes()],
        },
      },
      {
        extends: true,
        test: { name: 'security', include: ['tests/security/**/*.test.ts'] },
      },
    ],
  },
});
