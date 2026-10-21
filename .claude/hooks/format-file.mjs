#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): chạy prettier --write và eslint --fix trên file vừa sửa.
// - Gọi trực tiếp entry JS của prettier/eslint bằng node (shell: false) → không có command injection.
// - Chỉ xử lý file nằm trong project, bỏ qua node_modules.
// - Chưa có node_modules (Phase 1) → thoát 0 im lặng.
// - ESLint còn lỗi sau khi --fix → in ra stderr, exit 2 để Claude thấy và sửa.
// - Mọi lỗi khác → exit 0 (không chặn công việc).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRETTIER_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);
const ESLINT_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);
const isWin = process.platform === 'win32';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function norm(p) {
  const r = path.resolve(p);
  return isWin ? r.toLowerCase() : r;
}

function entry(projectDir, ...parts) {
  const p = path.join(projectDir, 'node_modules', ...parts);
  return existsSync(p) ? p : null;
}

function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return 0;
  }
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return 0;

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectDir = path.resolve(
    process.env.CLAUDE_PROJECT_DIR || input.cwd || path.join(scriptDir, '..', '..'),
  );

  const absFile = path.resolve(projectDir, filePath);
  const rel = path.relative(norm(projectDir), norm(absFile));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return 0;
  if (rel.split(path.sep).includes('node_modules')) return 0;
  if (!existsSync(absFile)) return 0;

  const ext = path.extname(absFile).toLowerCase();

  if (PRETTIER_EXT.has(ext)) {
    const prettier = entry(projectDir, 'prettier', 'bin', 'prettier.cjs');
    if (prettier) runNode(prettier, ['--write', '--ignore-unknown', absFile], projectDir);
  }

  if (ESLINT_EXT.has(ext)) {
    const eslint = entry(projectDir, 'eslint', 'bin', 'eslint.js');
    if (eslint) {
      const res = runNode(eslint, ['--fix', absFile], projectDir);
      // status 1 = còn lỗi lint; status 2 = lỗi cấu hình/crash → không chặn.
      if (res.status === 1) {
        process.stderr.write(
          `ESLint còn lỗi trong ${path.relative(projectDir, absFile)}:\n${res.stdout || ''}${res.stderr || ''}`,
        );
        return 2;
      }
    }
  }
  return 0;
}

let code = 0;
try {
  code = main();
} catch {
  code = 0;
}
process.exit(code);
