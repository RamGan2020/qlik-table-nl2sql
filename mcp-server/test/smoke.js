// Смоук-тест MCP-сервера через stdio (newline-delimited JSON-RPC).
// Проверяет: initialize, список инструментов, execute_sql (SELECT + отказ от DELETE),
// nl_to_sql без ключа (ожидается понятная ошибка), refresh_schema.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [join(root, 'src', 'index.js')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MOONSHOT_API_KEY: '' }, // тест без ключа: проверяем осмысленную ошибку
});

let buffer = '';
const pending = new Map();
let nextId = 1;
const failures = [];

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

child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Таймаут ожидания ответа на ${method}`));
      }
    }, 30000);
  });
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}  ${detail}`);
    failures.push(name);
  }
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  check('initialize', init.result?.serverInfo?.name === 'qlik-table-nl2sql', JSON.stringify(init));

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await send('tools/list');
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  check('tools/list содержит 3 инструмента',
    names.join(',') === 'execute_sql,nl_to_sql,refresh_schema', names.join(','));

  const sel = await send('tools/call', {
    name: 'execute_sql',
    arguments: { sql: 'SELECT count(*)::int AS n FROM objects' },
  });
  check('execute_sql SELECT', sel.result?.structuredContent?.rows?.[0]?.n === 3,
    JSON.stringify(sel.result).slice(0, 200));

  const del = await send('tools/call', {
    name: 'execute_sql',
    arguments: { sql: 'DELETE FROM objects' },
  });
  check('execute_sql DELETE отклонён', del.result?.isError === true);

  const nl = await send('tools/call', {
    name: 'nl_to_sql',
    arguments: { question: 'Продажи по каналам за 2026 год' },
  });
  check('nl_to_sql без ключа -> понятная ошибка',
    nl.result?.isError === true && /MOONSHOT_API_KEY/.test(nl.result?.content?.[0]?.text ?? ''),
    JSON.stringify(nl.result).slice(0, 200));

  const rs = await send('tools/call', { name: 'refresh_schema', arguments: {} });
  check('refresh_schema', typeof rs.result?.structuredContent?.schema === 'string' && rs.result.structuredContent.schema.includes('TABLE'));

  console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length}` : '\nВсе проверки пройдены.');
  process.exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error('ОШИБКА ТЕСТА:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
