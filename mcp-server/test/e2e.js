// End-to-end тест с реальным LLM: вопрос -> nl_to_sql -> execute_sql.
// Требует заполненного .env (MOONSHOT_API_KEY). Время работы: до 2 минут.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [join(root, 'src', 'index.js')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Таймаут ${timeoutMs / 1000}s на ${method}`));
      }
    }, timeoutMs);
  });
}

const question = process.argv[2] ?? 'Продажи по каналам за 2026 год: число сделок и выручка в млн рублей';

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log(`Вопрос: ${question}\nЖдём SQL от модели (до 2 минут)...`);

  const nl = await send('tools/call', { name: 'nl_to_sql', arguments: { question } });
  if (nl.result?.isError) {
    console.error('nl_to_sql вернул ошибку:', nl.result.content[0].text);
    process.exitCode = 1;
  } else {
    const { sql, explanation } = nl.result.structuredContent;
    console.log('\nSQL:', sql);
    console.log('Пояснение:', explanation);

    const ex = await send('tools/call', { name: 'execute_sql', arguments: { sql } }, 60000);
    if (ex.result?.isError) {
      console.error('execute_sql вернул ошибку:', ex.result.content[0].text);
      process.exitCode = 1;
    } else {
      const { columns, rows, rowCount } = ex.result.structuredContent;
      console.log(`\nРезультат (${rowCount} строк):`);
      console.log(columns.join(' | '));
      for (const r of rows.slice(0, 15)) console.log(columns.map((c) => r[c]).join(' | '));
      console.log('\nE2E OK');
    }
  }
} catch (e) {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
