// Юнит-тест пост-валидации: пары колонок джойнов проверяются против реального
// relationships.yaml, сущности — против фиктивной схемы. Без БД и LLM.
// Запуск: node test/validate-joins.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

import { validateSql, validateJoins } from '../src/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rels = YAML.parse(readFileSync(join(root, 'src', 'relationships.yaml'), 'utf8')).relationships ?? [];

// Фиктивная физическая схема (таблицы/колонки из db/schema.sql)
const knownTables = new Map(Object.entries({
  objects: new Set(['object_id', 'name', 'city', 'status']),
  buildings: new Set(['building_id', 'object_id', 'name', 'floors']),
  units: new Set(['unit_id', 'building_id', 'area', 'status']),
  channels: new Set(['channel_id', 'name']),
  sales: new Set(['sale_id', 'unit_id', 'channel_id', 'sale_date', 'price']),
  sales_plan: new Set(['plan_id', 'building_id', 'channel_id', 'month', 'plan_revenue']),
  construction_progress: new Set(['progress_id', 'building_id', 'month', 'fact_pct']),
  cashflow: new Set(['cashflow_id', 'object_id', 'month', 'fact_income']),
  dim_date: new Set(['date_id', 'year', 'month', 'quarter']),
}));

let passed = 0;
const failures = [];

function check(name, sql, { problems = 0, contains } = {}) {
  const found = validateJoins(sql, rels);
  const ok = contains ? found.some((p) => p.includes(contains)) : found.length === problems;
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}\n      SQL: ${sql}\n      ожидалось: ${contains ? `проблема содержит "${contains}"` : `${problems} проблем(ы)`}, получено: ${JSON.stringify(found, null, 2)}`);
  }
}

// --- объявленные связи: нет проблем ---
check('цепочка факт -> измерения', `
  SELECT b.name, sum(s.price)
  FROM sales s
  JOIN units u ON u.unit_id = s.unit_id
  JOIN buildings b ON b.building_id = u.building_id
  JOIN objects o ON o.object_id = b.object_id
  GROUP BY b.name`, { problems: 0 });

check('календарная связь по дате сделки', `
  SELECT d.month, sum(s.price)
  FROM sales s
  JOIN dim_date d ON d.date_id = s.sale_date
  GROUP BY d.month`, { problems: 0 });

check('таблицы без алиасов', `
  SELECT * FROM sales JOIN units ON units.unit_id = sales.unit_id`, { problems: 0 });

check('обратный порядок сторон в ON', `
  SELECT * FROM sales s JOIN units u ON s.unit_id = u.unit_id`, { problems: 0 });

check('регистр не важен', `
  SELECT * FROM SALES S JOIN UNITS U ON U.UNIT_ID = S.UNIT_ID`, { problems: 0 });

check('USING по колонке из реестра', `
  SELECT * FROM sales s JOIN units u USING (unit_id)`, { problems: 0 });

// --- незадекларированные пары: проблема ---
check('незадекларированная пара', `
  SELECT * FROM sales s JOIN objects o ON o.object_id = s.unit_id`,
  { contains: 'objects.object_id = sales.unit_id' });

check('незадекларированная пара в WHERE (неявный джойн)', `
  SELECT * FROM sales s, buildings b WHERE b.object_id = s.unit_id`,
  { contains: 'buildings.object_id = sales.unit_id' });

check('USING по колонке вне реестра', `
  SELECT * FROM sales s JOIN units u USING (area)`,
  { contains: 'USING (area)' });

// --- не верифицируем: пропуск без проблем ---
check('выражение в ON пропускается', `
  SELECT * FROM sales s JOIN dim_date d ON date_trunc('month', s.sale_date) = d.date_id`, { problems: 0 });

check('строковый литерал в ON не даёт ложного срабатывания', `
  SELECT * FROM sales s JOIN units u ON u.unit_id = s.unit_id AND u.status = 'sold'`, { problems: 0 });

check('джойн с подзапросом пропускается', `
  SELECT * FROM sales s JOIN (SELECT unit_id, status FROM units) x ON x.unit_id = s.unit_id`, { problems: 0 });

check('CTE пропускается', `
  WITH x AS (SELECT unit_id FROM units) SELECT * FROM sales s JOIN x ON x.unit_id = s.unit_id`, { problems: 0 });

check('самоджойн той же таблицы пропускается', `
  SELECT * FROM units a JOIN units b ON a.building_id = b.building_id`, { problems: 0 });

// --- интеграция с validateSql: проблемы сущностей и джойнов вместе ---
{
  const sql = 'SELECT * FROM sales s JOIN objects o ON o.object_id = s.unit_id JOIN nosuchtable n ON n.id = s.unit_id';
  const problems = validateSql(sql, knownTables, rels);
  const hasEntity = problems.some((p) => p.includes('nosuchtable'));
  const hasJoin = problems.some((p) => p.includes('незадекларированной связи'));
  if (hasEntity && hasJoin) {
    passed++;
    console.log('PASS  validateSql объединяет проблемы сущностей и джойнов');
  } else {
    failures.push('validateSql-интеграция');
    console.log(`FAIL  validateSql объединяет проблемы сущностей и джойнов\n      получено: ${JSON.stringify(problems)}`);
  }
}

// --- обратная совместимость: без relationships — только сущности ---
{
  const problems = validateSql('SELECT * FROM sales s JOIN objects o ON o.object_id = s.unit_id', knownTables);
  if (problems.length === 0) {
    passed++;
    console.log('PASS  без relationships проверка джойнов пропускается');
  } else {
    failures.push('без-relationships');
    console.log(`FAIL  без relationships проверка джойнов пропускается\n      получено: ${JSON.stringify(problems)}`);
  }
}

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
