// Юнит-тест IR v2: подпланы (with) -> CTE, join-ы, выражения, фильтры
// «мера против меры». Компиляция + детерминизм + выполнение на БД.
// Запуск: node test/compiler-v2.js

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
    check(`${name}: детерминизм`, sql === again);
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

// --- 1. план/факт по объектам (left join от справочника, coalesce) ---
{
  const plan = {
    with: [
      { name: 'plan', from: 'sales_plan',
        select: [{ ref: 'object', alias: 'object' }, { ref: 'planned_revenue', alias: 'plan_rev' }],
        where: [{ ref: 'month', op: '>=', value: '2026-01-01' }, { ref: 'month', op: '<', value: '2027-01-01' }],
        group_by: ['object'] },
      { name: 'fact', from: 'sales',
        select: [{ ref: 'object', alias: 'object' }, { ref: 'revenue', alias: 'fact_rev' }],
        where: [{ ref: 'sale_date', op: '>=', value: '2026-01-01' }, { ref: 'sale_date', op: '<', value: '2027-01-01' }],
        group_by: ['object'] },
      { name: 'objs', from: 'objects', select: [{ ref: 'name', alias: 'object' }] },
    ],
    join: [
      { cte: 'objs' },
      { cte: 'plan', type: 'left', on: [['object', 'object']] },
      { cte: 'fact', type: 'left', on: [['object', 'object']] },
    ],
    select: [
      { cte: 'objs', col: 'object', alias: 'object' },
      { expr: { fn: 'coalesce', args: [{ cte: 'plan', col: 'plan_rev' }, 0] }, alias: 'plan_mln', scale: 1000000, round: 1 },
      { expr: { fn: 'coalesce', args: [{ cte: 'fact', col: 'fact_rev' }, 0] }, alias: 'fact_mln', scale: 1000000, round: 1 },
    ],
    order_by: [{ alias: 'object', dir: 'asc' }],
  };
  const sql = compiles('план/факт по объектам', plan,
    ['WITH plan AS', 'objs AS (', 'objs.object = plan.object', 'objs.object = fact.object', 'COALESCE']);
  if (sql) {
    check('план/факт: нет FULL без type', !/FULL OUTER/.test(sql), sql);
    const rows = await executes('план/факт по объектам', sql);
    if (rows) check('план/факт: нули на объектах без плана', rows.some((r) => Number(r.plan_mln) === 0), JSON.stringify(rows[0]));
  }
}

// --- 2. процент выполнения плана (full join + where по колонке CTE) ---
{
  const plan = {
    with: [
      { name: 'plan', from: 'sales_plan',
        select: [{ ref: 'object', alias: 'object' }, { ref: 'planned_revenue', alias: 'plan_rev' }],
        where: [{ ref: 'month', op: '>=', value: '2026-01-01' }, { ref: 'month', op: '<', value: '2027-01-01' }],
        group_by: ['object'] },
      { name: 'fact', from: 'sales',
        select: [{ ref: 'object', alias: 'object' }, { ref: 'revenue', alias: 'fact_rev' }],
        where: [{ ref: 'sale_date', op: '>=', value: '2026-01-01' }, { ref: 'sale_date', op: '<', value: '2027-01-01' }],
        group_by: ['object'] },
    ],
    join: [{ cte: 'plan' }, { cte: 'fact', type: 'full', on: [['object', 'object']] }],
    select: [
      { expr: { fn: 'coalesce', args: [{ cte: 'plan', col: 'object' }, { cte: 'fact', col: 'object' }] }, alias: 'object' },
      { expr: { op: '*', a: 100, b: { op: '/', a: { fn: 'coalesce', args: [{ cte: 'fact', col: 'fact_rev' }, 0] }, b: { cte: 'plan', col: 'plan_rev' } } }, alias: 'completion_pct', round: 1 },
    ],
    where: [{ ref: 'plan.plan_rev', op: '>', value: 0 }],
    order_by: [{ alias: 'object', dir: 'asc' }],
  };
  const sql = compiles('процент выполнения плана', plan, ['FULL OUTER JOIN', 'COALESCE(plan.object, fact.object)']);
  if (sql) await executes('процент выполнения плана', sql);
}

// --- 3. факторный анализ (cross join подпланов-строк) ---
{
  const plan = {
    with: [
      { name: 'plan', from: 'sales_plan',
        select: [
          { ref: 'planned_units', alias: 'plan_units' },
          { ref: 'planned_area', alias: 'plan_m2' },
          { expr: { op: '/', a: { ref: 'planned_revenue' }, b: { ref: 'planned_area' } }, alias: 'plan_price' },
        ],
        where: [{ ref: 'month', op: '=', value: '2026-10-01' }, { ref: 'object', op: '=', value: 'ЖК «Заречный»' }] },
      { name: 'fact', from: 'sales',
        select: [
          { ref: 'deals', alias: 'fact_units' },
          { ref: 'sold_area', alias: 'fact_m2' },
          { ref: 'avg_price_per_m2', alias: 'fact_price' },
        ],
        where: [{ ref: 'sale_date', op: '>=', value: '2026-10-01' }, { ref: 'sale_date', op: '<', value: '2026-11-01' }, { ref: 'object', op: '=', value: 'ЖК «Заречный»' }] },
    ],
    join: [{ cte: 'plan' }, { cte: 'fact', type: 'cross' }],
    select: [
      { cte: 'plan', col: 'plan_units', alias: 'plan_units' },
      { cte: 'fact', col: 'fact_units', alias: 'fact_units' },
      { expr: { op: '*', a: { op: '-', a: { cte: 'fact', col: 'fact_m2' }, b: { cte: 'plan', col: 'plan_m2' } }, b: { cte: 'plan', col: 'plan_price' } }, alias: 'volume_effect_mln', scale: 1000000, round: 1 },
      { expr: { op: '*', a: { op: '-', a: { cte: 'fact', col: 'fact_price' }, b: { cte: 'plan', col: 'plan_price' } }, b: { cte: 'fact', col: 'fact_m2' } }, alias: 'price_effect_mln', scale: 1000000, round: 1 },
    ],
  };
  const sql = compiles('факторный анализ (cross join)', plan, ['CROSS JOIN fact']);
  if (sql) {
    const rows = await executes('факторный анализ', sql, 1);
    if (rows) check('факторный: одна строка', rows.length === 1, `строк: ${rows.length}`);
  }
}

// --- 4. фильтр «мера против меры» (v1-модель, value = expr) ---
{
  const plan = {
    from: 'construction_progress',
    select: [
      { ref: 'building_full', alias: 'building' },
      { ref: 'readiness_pct', alias: 'fact_pct' },
      { ref: 'planned_readiness_pct', alias: 'plan_pct' },
    ],
    where: [{ ref: 'readiness_pct', op: '<', value: { op: '-', a: { ref: 'planned_readiness_pct' }, b: 5 } }],
    order_by: [{ alias: 'building', dir: 'asc' }],
  };
  const sql = compiles('фильтр мера-к-мере', plan, ['AS _snap WHERE', 'fact_pct < (plan_pct) - (5)']);
  if (sql) {
    check('фильтр мера-к-мере: срез обёрнут', /SELECT \* FROM \(SELECT DISTINCT ON/.test(sql), sql);
    await executes('фильтр мера-к-мере', sql);
  }
}

// --- отказы ---
const W = (extra) => ({
  with: [
    { name: 'a', from: 'sales', select: [{ ref: 'deals', alias: 'deals' }] },
    { name: 'b', from: 'channels', select: [{ ref: 'name', alias: 'name' }] },
  ],
  join: [{ cte: 'a' }, { cte: 'b', type: 'cross' }],
  select: [{ cte: 'a', col: 'deals', alias: 'deals' }],
  ...extra,
});
refused('v2: неизвестный подплан в join', W({ join: [{ cte: 'a' }, { cte: 'nosuch', type: 'cross' }] }), 'неизвестный подплан "nosuch"');
refused('v2: нет колонки в on', W({ join: [{ cte: 'a' }, { cte: 'b', type: 'inner', on: [['deals', 'nosuch_col']] }] }), 'не разрешается');
refused('v2: cross с on', W({ join: [{ cte: 'a' }, { cte: 'b', type: 'cross', on: [['deals', 'name']] }] }), 'CROSS JOIN не принимает on');
refused('v2: нет on у inner', W({ join: [{ cte: 'a' }, { cte: 'b', type: 'inner' }] }), 'нужен on');
refused('v2: select нет колонки', W({ select: [{ cte: 'a', col: 'nosuch', alias: 'x' }] }), 'нет колонки "nosuch"');
refused('v2: where без подплана.колонки', W({ where: [{ ref: 'deals', op: '>', value: 1 }] }), '"подплан.колонка"');
refused('v2: group_by во внешнем', W({ group_by: ['deals'] }), 'group_by во внешнем запросе');
refused('v2: expr с чужим cte', W({ select: [{ expr: { cte: 'nosuch', col: 'x' }, alias: 'y' }] }), 'неизвестный подплан "nosuch"');
refused('v1: cte+col в одиночной модели', { from: 'sales', select: [{ cte: 'x', col: 'y', alias: 'z' }] }, 'cte+col допустимы только во внешнем запросе');
refused('v1: ref в value несуществующий', {
  from: 'sales',
  select: [{ ref: 'deals', alias: 'deals' }],
  where: [{ ref: 'sale_date', op: '>', value: { ref: 'nosuch_measure' } }],
}, 'нет измерения или меры "nosuch_measure"');

await pool.end();

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
