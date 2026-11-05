// Eval-раннер: гоняет вопросы из eval/questions.json через живой MCP-сервер
// и сравнивает результаты сгенерированного SQL с эталонными.
//
// Уровни проверки:
//   L0 — nl_to_sql вернул SQL без ошибки
//   L1 — SQL выполнился в БД
//   L2 — результат совпал с эталоном (позиционное сравнение строк с допуском)
//
// Запуск:
//   node eval/run.js                 # весь набор (~5-15 мин: 40 вызовов LLM)
//   node eval/run.js --level 1       # только простые
//   node eval/run.js --limit 5       # первые N кейсов
//   node eval/run.js --only id1,id2  # конкретные кейсы
//   node eval/run.js --min-score 90  # порог прохождения, по умолчанию 80
//   node eval/run.js --check-refs    # без LLM: проверить эталонные SQL на базе
//
// Отчёт пишется в eval/report.json (в .gitignore).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(join(root, 'eval', 'questions.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
};
const hasFlag = (name) => args.includes(`--${name}`);
const LEVEL = flag('level');
const ONLY = flag('only');
const LIMIT = Number(flag('limit', 0));
const MIN_SCORE = Number(flag('min-score', 80));

let selected = cases;
if (LEVEL) selected = selected.filter((c) => c.level === Number(LEVEL));
if (ONLY) {
  const ids = ONLY.split(',').map((s) => s.trim());
  selected = selected.filter((c) => ids.includes(c.id));
}
if (LIMIT) selected = selected.slice(0, LIMIT);

if (!selected.length) {
  console.error('Ни один кейс не выбран.');
  process.exit(2);
}

// ---------- MCP-клиент поверх stdio ----------

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

function send(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`таймаут ${timeoutMs / 1000}s на ${method}`));
      }
    }, timeoutMs);
  });
}

async function callTool(name, args, timeoutMs) {
  const r = await send('tools/call', { name, arguments: args }, timeoutMs);
  if (r.error) throw new Error(`MCP error: ${r.error.message}`);
  return r.result;
}

const callExecute = (sql) =>
  callTool('execute_sql', { sql }, 60000).then((r) => {
    if (r.isError) throw new Error(r.content[0].text);
    return r.structuredContent;
  });

// ---------- Сравнение результатов ----------

function normCell(v) {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'number') return { t: 'num', v };
  const s = String(v).trim().replace(/\s+/g, ' ');
  const asNum = Number(s.replace(',', '.'));
  if (s !== '' && Number.isFinite(asNum) && /^-?[\d\s.,]+$/.test(s)) return { t: 'num', v: asNum };
  const m = s.match(/^(\d{4})-(\d{2})-01$/); // дата первого числа месяца -> YYYY-MM
  if (m) return { t: 'str', v: `${m[1]}-${m[2]}` };
  return { t: 'str', v: s };
}

function cellsEqual(a, b) {
  if (a.t !== b.t) return false;
  if (a.t === 'null') return true;
  if (a.t === 'num') {
    const diff = Math.abs(a.v - b.v);
    return diff <= 0.11 || diff <= 0.015 * Math.max(Math.abs(a.v), Math.abs(b.v));
  }
  return a.v === b.v;
}

function rowMatches(gen, ref, nCols) {
  for (let i = 0; i < nCols; i++) {
    if (!cellsEqual(normCell(gen[i]), normCell(ref[i]))) return false;
  }
  return true;
}

function compareResults(gen, ref) {
  // Перебираем инъективные мэппинги эталонных колонок на сгенерированные.
  // Имена нормализуются (суффиксы pct/mln/share/name и т.п. не значимы);
  // если по имени не смапилось — перебираем оставшиеся колонки и проверяем
  // мэтч полным мультимножеством строк. Модель вправе добавлять свои колонки.
  const normName = (s) => {
    const n = s.toLowerCase().trim().replace(/([_ ](pct|percent|mln|share|cnt|count|name))+$/i, '');
    return n || s.toLowerCase().trim();
  };
  if (gen.columns.length < ref.columns.length) {
    return { ok: false, why: `колонок ${gen.columns.length} < эталонных ${ref.columns.length}` };
  }
  if (gen.rows.length !== ref.rows.length) {
    return { ok: false, why: `строк ${gen.rows.length} вместо ${ref.rows.length}` };
  }
  const genNorm = gen.columns.map(normName);
  const refNorm = ref.columns.map(normName);
  const nRef = ref.columns.length;
  const nGen = gen.columns.length;

  const rowsEqualFor = (assign) => {
    const used = new Array(gen.rows.length).fill(false);
    for (const refRow of ref.rows) {
      const refArr = ref.columns.map((c) => refRow[c]);
      const idx = gen.rows.findIndex((g, i) => {
        if (used[i]) return false;
        const genArr = assign.map((m) => g[gen.columns[m]]);
        return rowMatches(genArr, refArr, nRef);
      });
      if (idx === -1) return false;
      used[idx] = true;
    }
    return true;
  };

  const assign = new Array(nRef).fill(-1);
  const usedCol = new Array(nGen).fill(false);
  let found = false;
  (function dfs(i) {
    if (found) return;
    if (i === nRef) {
      if (rowsEqualFor(assign)) found = true;
      return;
    }
    // сначала колонки с совпавшим именем, потом остальные
    const order = [];
    for (let j = 0; j < nGen; j++) if (!usedCol[j]) order.push(j);
    order.sort((a, b) => (genNorm[b] === refNorm[i]) - (genNorm[a] === refNorm[i]));
    for (const j of order) {
      usedCol[j] = true;
      assign[i] = j;
      dfs(i + 1);
      usedCol[j] = false;
      assign[i] = -1;
      if (found) return;
    }
  })(0);

  if (!found) {
    return { ok: false, why: `строка не найдена: ${JSON.stringify(ref.columns.map((c) => ref.rows[0][c])).slice(0, 140)}` };
  }
  return { ok: true };
}

// ---------- Режим проверки эталонов ----------

if (hasFlag('check-refs')) {
  try {
    await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'eval-check', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    let failed = 0;
    for (const c of selected) {
      try {
        const r = await callExecute(c.reference_sql);
        console.log(`OK    ${c.id}  строк: ${r.rowCount}  ${JSON.stringify(r.rows[0] ?? null).slice(0, 110)}`);
      } catch (e) {
        console.log(`FAIL  ${c.id}  ${e.message.slice(0, 200)}`);
        failed++;
      }
    }
    console.log(failed ? `\nБитых эталонов: ${failed}` : '\nВсе эталоны выполняются.');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('ОШИБКА:', e.message);
    process.exitCode = 2;
  } finally {
    child.kill();
  }
  process.exit();
}

// ---------- Основной прогон ----------

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'eval-run', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const report = [];
  console.log(`Кейсов: ${selected.length}\n`);

  for (const [i, c] of selected.entries()) {
    const t0 = Date.now();
    const rec = { id: c.id, level: c.level, question: c.question, level_passed: null };
    process.stdout.write(`[${i + 1}/${selected.length}] ${c.id} ... `);

    try {
      const nl = await callTool('nl_to_sql', { question: c.question }, 180000);
      if (nl.isError) {
        rec.level_passed = 'L0';
        rec.error = nl.content[0].text;
      } else {
        rec.generated_sql = nl.structuredContent.sql;
        try {
          const genRes = await callExecute(nl.structuredContent.sql);
          rec.level_passed = 'L1';
          const refRes = await callExecute(c.reference_sql);
          const cmp = compareResults(genRes, refRes);
          rec.level_passed = cmp.ok ? 'L2' : 'L1';
          rec.why = cmp.why;
        } catch (e) {
          rec.error = e.message.slice(0, 300);
        }
      }
    } catch (e) {
      rec.level_passed = 'L0';
      rec.error = e.message;
    }

    rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
    report.push(rec);
    const mark = rec.level_passed === 'L2' ? 'PASS' : rec.level_passed === 'L1' ? 'EXEC' : 'FAIL';
    console.log(`${mark}  ${rec.level_passed}  (${rec.seconds}s)${rec.why ? '  ' + rec.why : ''}${rec.error ? '  ' + rec.error.slice(0, 120) : ''}`);
  }

  const passed = report.filter((r) => r.level_passed === 'L2').length;
  const execOnly = report.filter((r) => r.level_passed === 'L1').length;
  const failed = report.filter((r) => r.level_passed === 'L0').length;
  const score = Math.round((100 * passed) / report.length);
  const byLevel = [1, 2, 3].map((l) => {
    const s = report.filter((r) => r.level === l);
    if (!s.length) return null;
    return `L${l}: ${s.filter((r) => r.level_passed === 'L2').length}/${s.length}`;
  }).filter(Boolean).join('  ');

  writeFileSync(join(root, 'eval', 'report.json'), JSON.stringify({ when: new Date().toISOString(), score, report }, null, 2));

  console.log(`\nИтог: совпало с эталоном (L2) — ${passed}/${report.length} (${score}%)`);
  console.log(`Выполняется, но отличается (L1) — ${execOnly}; не сгенерировалось/упало (L0) — ${failed}`);
  console.log(`По уровням: ${byLevel}`);
  console.log('Отчёт: eval/report.json');
  console.log(score >= MIN_SCORE ? `Порог ${MIN_SCORE}% пройден.` : `НИЖЕ ПОРОГА ${MIN_SCORE}% — регрессия.`);
  process.exitCode = score >= MIN_SCORE ? 0 : 1;
} catch (e) {
  console.error('ОШИБКА РАННЕРА:', e.message);
  process.exitCode = 2;
} finally {
  child.kill();
}
