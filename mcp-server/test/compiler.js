// Юнит-тест компилятора IR -> SQL: реальные семантические модели и связи,
// проверка детерминизма (один план -> один SQL) и выполнение сгенерированного
// SQL на базе (read-only). Запуск: node test/compiler.js

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

import { createSemanticLoader } from '../src/semantic.js';
import { compilePlan } from '../src/compiler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const semantic = createSemanticLoader(
  join(root, 'src', 'models'),
  join(root, 'src', 'relationships.yaml'),
)();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/qlik_table',
  max: 2,
  options: '-c default_transaction_read_only=on -c statement_timeout=15000',
});
pool.on('error', () => {});

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function compiles(name, plan, contains = []) {
  try {
    const sql = compilePlan(plan, semantic);
    const again = compilePlan(plan, semantic);
    check(`${name}: компилируется`, true);
    check(`${name}: детерминизм`, sql === again, `первый: ${sql}\n      второй: ${again}`);
    const missing = contains.filter((s) => !sql.includes(s));
    check(`${name}: содержит ${JSON.stringify(contains)}`, !missing.length, `нет: ${missing.join(', ')}\n      SQL: ${sql}`);
    return sql;
  } catch (e) {
    check(`${name}: компилируется`, false, e.message);
    return null;
  }
}

function refused(name, plan, fragment) {
  try {
    compilePlan(plan, semantic);
    check(`${name}: отказ`, false, 'ожидался отказ, план скомпилировался');
  } catch (e) {
    check(`${name}: отказ`, e.message.includes(fragment), `ожидалось "${fragment}", получено: ${e.message}`);
  }
}

async function executes(name, sql, minRows = 1) {
  try {
    const { rows } = await pool.query(sql);
    check(`${name}: выполняется на БД`, rows.length >= minRows, `строк: ${rows.length} < ${minRows}\n      SQL: ${sql}`);
    return rows;
  } catch (e) {
    check(`${name}: выполняется на БД`, false, `${e.message}\n      SQL: ${sql}`);
    return null;
  }
}

// --- валидные планы ---
{
  const sql = compiles('сделки по каналам 2026', {
    from: 'sales',
    select: [{ ref: 'channel', alias: 'channel' }, { ref: 'deals', alias: 'deals' }],
    where: [
      { ref: 'sale_date', op: '>=', value: '2026-01-01' },
      { ref: 'sale_date', op: '<', value: '2027-01-01' },
    ],
    order_by: [{ alias: 'deals', dir: 'desc' }],
  }, ['FROM sales AS s', 'JOIN channels AS c ON s.channel_id = c.channel_id', 's.sale_date >=', 'GROUP BY']);
  if (sql) await executes('сделки по каналам 2026', sql);
}

{
  const sql = compiles('выручка по объектам 2026 (3-хоповый джойн)', {
    from: 'sales',
    select: [{ ref: 'object', alias: 'object' }, { ref: 'revenue', alias: 'revenue_mln', scale: 1000000, round: 1 }],
    where: [
      { ref: 'sale_date', op: '>=', value: '2026-01-01' },
      { ref: 'sale_date', op: '<', value: '2027-01-01' },
    ],
  }, ['JOIN units AS u ON s.unit_id = u.unit_id', 'JOIN buildings AS b ON u.building_id = b.building_id', 'JOIN objects AS o ON b.object_id = o.object_id', 'ROUND((SUM(s.price)) / 1000000, 1)']);
  if (sql) {
    check('3-хоповый джойн: без лишних таблиц', !/construction_progress|sales_plan|cashflow/.test(sql), sql);
    await executes('выручка по объектам 2026', sql);
  }
}

{
  const sql = compiles('помесячная выручка', {
    from: 'sales',
    select: [{ ref: 'month', alias: 'month' }, { ref: 'revenue', alias: 'revenue_mln', scale: 1000000, round: 1 }],
    where: [
      { ref: 'sale_date', op: '>=', value: '2026-01-01' },
      { ref: 'sale_date', op: '<', value: '2027-01-01' },
    ],
    order_by: [{ alias: 'month', dir: 'asc' }],
  }, ['TO_CHAR']);
  if (sql) await executes('помесячная выручка', sql, 2);
}

{
  const sql = compiles('остаток свободных квартир по объектам', {
    from: 'units',
    select: [{ ref: 'object', alias: 'object' }, { ref: 'available_units', alias: 'available_units' }],
    order_by: [{ alias: 'object', dir: 'asc' }],
  }, ["FILTER(WHERE u.status = 'available')"]);
  if (sql) await executes('остаток свободных квартир', sql);
}

{
  const sql = compiles('доля ипотеки', {
    from: 'sales',
    select: [{ ref: 'mortgage_share_pct', alias: 'mortgage_pct' }],
    where: [
      { ref: 'sale_date', op: '>=', value: '2026-01-01' },
      { ref: 'sale_date', op: '<', value: '2027-01-01' },
    ],
  }, ['FILTER(WHERE s.mortgage)']);
  if (sql) await executes('доля ипотеки', sql);
}

{
  const sql = compiles('фильтр IN по домену', {
    from: 'sales',
    select: [{ ref: 'deals', alias: 'deals' }],
    where: [{ ref: 'contract', op: 'in', value: ['ДДУ', 'Рассрочка'] }],
  }, ['IN (']);
  if (sql) await executes('фильтр IN', sql);
}

{
  const sql = compiles('HAVING по мере', {
    from: 'sales',
    select: [{ ref: 'channel', alias: 'channel' }, { ref: 'revenue', alias: 'revenue' }],
    where: [{ ref: 'revenue', op: '>', value: 0 }],
  }, ['HAVING']);
  if (sql) await executes('HAVING по мере', sql);
}

{
  const sql = compiles('latest_snapshot: готовность корпусов', {
    from: 'construction_progress',
    select: [
      { ref: 'building', alias: 'building' },
      { ref: 'readiness_pct', alias: 'readiness_pct' },
      { ref: 'stage', alias: 'stage' },
    ],
  }, ['DISTINCT ON (p.building_id)', 'p.month DESC']);
  if (sql) {
    check('DISTINCT ON: без GROUP BY', !/GROUP BY/.test(sql), sql);
    await executes('готовность корпусов', sql);
  }
}

{
  const sql = compiles('is_null фильтр', {
    from: 'objects',
    select: [{ ref: 'name', alias: 'object' }, { ref: 'end_date', alias: 'end_date' }],
    where: [{ ref: 'end_date', op: 'is_null' }],
  }, ['IS NULL']);
  if (sql) await executes('is_null фильтр', sql, 0);
}

// экранирование кавычки в строковом литерале
{
  const sql = compiles('экранирование кавычки', {
    from: 'objects',
    select: [{ ref: 'name', alias: 'object' }],
    where: [{ ref: 'name', op: '=', value: "O'Brien" }],
  }, ["O''Brien"]);
}

// --- отказы ---
refused('неизвестная модель', { from: 'nosuch', select: [{ ref: 'x', alias: 'x' }] }, 'неизвестная модель');
refused('неизвестный ref', { from: 'sales', select: [{ ref: 'nosuch', alias: 'x' }] }, 'нет измерения или меры "nosuch"');
refused('значение вне домена', {
  from: 'sales',
  select: [{ ref: 'deals', alias: 'deals' }],
  where: [{ ref: 'contract', op: '=', value: 'Foo' }],
}, 'вне домена');
refused('плохая дата', {
  from: 'sales',
  select: [{ ref: 'deals', alias: 'deals' }],
  where: [{ ref: 'sale_date', op: '>=', value: '2026-13-45' }],
}, 'YYYY-MM-DD');
refused('group_by не из select', {
  from: 'sales',
  select: [{ ref: 'channel', alias: 'channel' }, { ref: 'deals', alias: 'deals' }],
  group_by: ['contract'],
}, 'group_by');
refused('order_by по чужому алиасу', {
  from: 'sales',
  select: [{ ref: 'deals', alias: 'deals' }],
  order_by: [{ alias: 'nosuch', dir: 'asc' }],
}, 'order_by');
refused('scale на измерении', {
  from: 'sales',
  select: [{ ref: 'channel', alias: 'channel', scale: 100 }],
}, 'scale/round');
refused('latest_snapshot + group_by', {
  from: 'construction_progress',
  select: [{ ref: 'building', alias: 'building' }, { ref: 'readiness_pct', alias: 'r' }],
  group_by: ['building'],
}, 'latest_snapshot');
refused('дубль алиаса', {
  from: 'sales',
  select: [{ ref: 'deals', alias: 'x' }, { ref: 'revenue', alias: 'x' }],
}, 'дублирующийся алиас');

await pool.end();

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
