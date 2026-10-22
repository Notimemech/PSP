#!/usr/bin/env node
// PreToolUse hook: chặn truy cập file .env (trừ .env.example) và chặn gọi host VNPay production (*.vnpay.vn).
// Bổ sung cho permissions.deny (deny chỉ khớp pattern liệt kê sẵn). Đây là lớp chặn theo chuỗi, không phải
// sandbox: lệnh cố tình làm rối (ghép chuỗi, base64, biến...) vẫn có thể lọt.
// Exit 2 + stderr = chặn tool call; mọi trường hợp khác exit 0.
// Chỉ dùng module built-in, không spawn process, không shell.
import { readFileSync } from 'node:fs';

// Trường của tool_input được kiểm tra (theo tool). Grep.pattern là regex nội dung, không phải đường dẫn,
// nên không kiểm tra (tránh chặn nhầm việc tìm chữ ".env" trong code); Grep.path/glob vẫn được kiểm tra.
// Write/Edit chỉ kiểm tra file_path, không kiểm tra nội dung ghi.
const FIELDS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['path', 'glob'],
  Bash: ['command'],
  PowerShell: ['command'],
  WebFetch: ['url'],
};
// Tool khác (vd mcp__*): kiểm tra các trường thường chứa đường dẫn/URL.
const DEFAULT_FIELDS = [
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'command',
  'url',
  'glob',
  'uri',
  'href',
];

// .env hoặc .env.<x> đứng như một tên file (có ranh giới trước/sau).
const ENV_RE = /(^|[\\/\s"'`=:,;({<>|[+])\.env(\.[A-Za-z0-9_.*?-]*)?(?=$|[\s"'`;|&)}<>,*?\\/:\]+~])/gi;
// Host kết thúc bằng vnpay.vn (pay.vnpay.vn, merchant.vnpay.vn, vnpay.vn...). Không khớp vnpayment.vn,
// không khớp tên file kiểu "vnpay.vn.md".
const VNPAY_PROD_RE = /(^|[^A-Za-z0-9-])((?:[A-Za-z0-9-]+\.)*vnpay\.vn)(?!\.?[A-Za-z0-9-])/i;
const VNPAY_HOSTNAME_RE = /(^|\.)vnpay\.vn\.?$/i;

// Trình thông dịch/lệnh sẽ THỰC THI nội dung heredoc/here-string → không được bỏ thân.
const INTERPRETER_RE =
  /(^|[\s|;&(`$])(bash|sh|zsh|dash|ksh|fish|cmd|node|nodejs|deno|bun|tsx|ts-node|npx|python[0-9.]*|py|perl|ruby|php|pwsh|powershell|eval|source|exec|xargs|iex|Invoke-Expression|Invoke-Command|psql|sqlite3|docker|ssh)(\.exe)?(?=$|[\s;|&)'"])/i;

// Bash: mọi pipe đều coi là có thể thực thi thân (thận trọng). PowerShell: "@'..'@ | Set-Content" là cách ghi file
// thông dụng nên chỉ tính khi pipe/truyền vào trình thông dịch (iex, node, pwsh...).
function executesBody(context, anyPipe = true) {
  return (anyPipe && context.includes('|')) || INTERPRETER_RE.test(context);
}

// Bỏ thân heredoc của Bash nếu thân chỉ là dữ liệu (ghi file, in ra), giữ lại dòng lệnh và delimiter.
function stripBashHeredocs(cmd) {
  const lines = cmd.split(/\r?\n/);
  const out = [];
  const opRe = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const ops = [...line.matchAll(opRe)];
    if (ops.length === 0) continue;
    const keep = executesBody(line);
    for (const op of ops) {
      const dash = op[1] === '-';
      const quoted = op[2] !== '';
      const delim = op[3];
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = dash ? lines[j].replace(/^\t+/, '') : lines[j];
        if (l === delim) break;
        body.push(lines[j]);
      }
      // Delimiter không có dấu nháy → shell vẫn expand $(...), `...`, ${...} trong thân.
      const expands = !quoted && /\$\(|`|\$\{/.test(body.join('\n'));
      if (keep || expands) out.push(...body);
      if (j < lines.length) out.push(lines[j]);
      i = j;
    }
  }
  return out.join('\n');
}

// Bỏ thân here-string PowerShell (@'...'@, @"..."@) nếu không bị đưa vào trình thông dịch.
function stripPsHereStrings(cmd) {
  const re = /@(['"])\r?\n([\s\S]*?)\r?\n\1@/g;
  return cmd.replace(re, (whole, q, body, offset, str) => {
    const lineStart = str.lastIndexOf('\n', offset) + 1;
    const end = offset + whole.length;
    let lineEnd = str.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = str.length;
    const context = str.slice(lineStart, offset) + ' ' + str.slice(end, lineEnd);
    const expands = q === '"' && /\$\(|\$\{/.test(body);
    if (executesBody(context, false) || expands) return whole;
    return `@${q}\n${q}@`;
  });
}

function normalizeHost(s) {
  return s.replace(/%2e/gi, '.').replace(/[。．｡]/g, '.');
}

function findViolation(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const fields = FIELDS[toolName] ?? DEFAULT_FIELDS;
  for (const f of fields) {
    let v = toolInput[f];
    if (typeof v !== 'string' || v.length === 0) continue;

    if (f === 'command') {
      if (toolName === 'PowerShell') v = stripPsHereStrings(v);
      else v = stripBashHeredocs(v);
    }

    for (const m of v.matchAll(ENV_RE)) {
      const suffix = m[2] ?? '';
      if (suffix.toLowerCase() === '.example') continue;
      return `Không được truy cập file môi trường "${'.env' + suffix}" (trường ${f}). Chỉ .env.example được phép.`;
    }

    const nv = normalizeHost(v);
    if (f === 'url') {
      try {
        const host = normalizeHost(new URL(nv).hostname);
        if (VNPAY_HOSTNAME_RE.test(host)) {
          return `Không được gọi host VNPay production "${host}" (trường ${f}). Chỉ dùng sandbox.vnpayment.vn.`;
        }
      } catch {
        // URL không parse được → so khớp chuỗi bên dưới
      }
    }
    const h = nv.match(VNPAY_PROD_RE);
    if (h) {
      return `Không được gọi/tham chiếu host VNPay production "${h[2]}" (trường ${f}). Chỉ dùng sandbox.vnpayment.vn.`;
    }
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return 0;
  }
  const reason = findViolation(input?.tool_name, input?.tool_input);
  if (reason) {
    process.stderr.write(`[guard] Bị chặn: ${reason}\nKhông tìm cách lách; nếu thật sự cần, hãy hỏi user.\n`);
    return 2;
  }
  return 0;
}

let code;
try {
  code = main();
} catch {
  code = 0;
}
process.exit(code);
