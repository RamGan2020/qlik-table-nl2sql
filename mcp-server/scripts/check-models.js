// Линт семантического ядра: src/models/*.yaml + src/relationships.yaml.
//
// Проверки:
// - YAML парсится, обязательные поля заполнены, типы известны;
// - имена измерений/мер уникальны внутри модели (компилятор ищет сначала
//   по измерениям — пересечение имён молча победит измерение);
// - синонимы не дублируются внутри модели (модель будет угадывать);
// - sql-фрагменты мер и измерений парсятся (@polyglot-sql/sdk, PostgreSQL);
// - requires_join ссылается на таблицы из реестра связей;
// - domain сверяется с фактическими значениями в БД (SELECT DISTINCT).
//   База недоступна — проверка пропускается с предупреждением (флаг
//   --require-db превращает пропуск в ошибку).
//
// Выход: 0 — всё чисто, 1 — есть ошибки.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';
import YAML from 'yaml';
import { parse, Dialect } from '@polyglot-sql/sdk';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../.env'), quiet: true });
dotenv.config({ quiet: true });

const MODELS_DIR = join(here, '../src/models');
const RELATIONSHIPS = join(here, '../src/relationships.yaml');
const PG = Dialect.PostgreSQL;

const DIM_TYPES = new Set(['string', 'integer', 'decimal', 'number', 'boolean', 'date']);
const MEASURE_TYPES = new Set(['simple', 'ratio', 'derived', 'latest_snapshot']);

const errors = [];
const warnings = [];
const err = (where, what) => errors.push(`${where}: ${what}`);
const warn = (where, what) => warnings.push(`${where}: ${what}`);

// ---------- загрузка ----------

const files = existsSync(MODELS_DIR)
  ? readdirSync(MODELS_DIR).filter((f) => f.endsWith('.yaml')).sort()
  : [];
if (!files.length) err(MODELS_DIR, 'нет YAML-файлов моделей');

const models = [];
for (const f of files) {
  try {
    const m = YAML.parse(readFileSync(join(MODELS_DIR, f), 'utf8'));
    if (m?.name) models.push({ ...m, __file: f });
    else err(f, 'нет поля name');
  } catch (e) {
    err(f, `YAML не парсится: ${e.message}`);
  }
}

let relationships = [];
try {
  relationships = YAML.parse(readFileSync(RELATIONSHIPS, 'utf8'))?.relationships ?? [];
} catch (e) {
  err('relationships.yaml', `не парсится: ${e.message}`);
}

const modelTables = new Set(models.map((m) => m.physical?.table).filter(Boolean));
const relatedTables = new Set();
for (const [i, r] of relationships.entries()) {
  const where = `relationships.yaml · связь #${i + 1} (${r.from} -> ${r.to})`;
  for (const side of [r.from, r.to]) {
    const s = String(side ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
      err(where, `сторона "${s}" должна быть в формате "таблица.колонка"`);
      continue;
    }
    const t = s.split('.')[0];
    relatedTables.add(t);
    if (!modelTables.has(t)) err(where, `таблица "${t}" не совпадает ни с одной моделью (physical.table)`);
  }
  if (r.role !== 'calendar' && r.type !== 'many_to_one' && r.type !== 'one_to_many') {
    err(where, 'type обязателен: many_to_one или one_to_many (без него компилятор не защитит запрос от fanout)');
  }
}

// ---------- статические проверки ----------

const seenModelNames = new Map();
const aliasOwners = new Map();
const tableOwners = new Map();
function checkFragment(where, sql) {
  const r = parse(`SELECT ${sql}`, PG);
  if (!r.success) err(where, `SQL-фрагмент не парсится: "${sql}" (${r.error})`);
}

// Таблицы, на которые ссылается фрагмент: "table." вне строковых литералов.
const tableRefRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g;
function sqlRefs(sql) {
  const stripped = String(sql).replace(/'(?:[^']|'')*'/g, "''");
  return [...stripped.matchAll(tableRefRe)].map((m) => m[1]);
}

function checkSqlRefs(where, sql) {
  checkFragment(where, sql);
  for (const t of sqlRefs(sql)) {
    if (!modelTables.has(t)) err(where, `SQL-фрагмент ссылается на таблицу "${t}", которой нет среди моделей: "${sql}"`);
  }
}

function checkRefsOnly(where, sql) {
  for (const t of sqlRefs(sql)) {
    if (!modelTables.has(t)) err(where, `ссылка на таблицу "${t}", которой нет среди моделей: "${sql}"`);
  }
}

for (const m of models) {
  const where = m.__file;
  if (!m.label) err(where, `модель "${m.name}": нет label`);
  if (!m.physical?.table) err(where, `модель "${m.name}": нет physical.table`);
  if (seenModelNames.has(m.name)) err(where, `имя модели "${m.name}" уже занято файлом ${seenModelNames.get(m.name)}`);
  seenModelNames.set(m.name, where);
  const tbl = m.physical?.table;
  if (tbl) {
    if (tableOwners.has(tbl)) err(where, `таблица "${tbl}" уже описана моделью ${tableOwners.get(tbl)}`);
    tableOwners.set(tbl, `модель "${m.name}"`);
  }
  const alias = m.physical?.alias;
  if (alias) {
    if (!/^[a-z][a-z0-9]*$/.test(alias)) err(where, `physical.alias "${alias}": только латиница в нижнем регистре и цифры, начало с буквы`);
    if (aliasOwners.has(alias)) err(where, `алиас "${alias}" уже занят (${aliasOwners.get(alias)})`);
    aliasOwners.set(alias, `модель "${m.name}"`);
  } else if (tbl) {
    warn(where, `нет physical.alias: алиас таблицы "${tbl}" выведется автоматически и может смениться при добавлении таблиц — задайте явный alias`);
  }

  const names = new Map(); // каноническое имя -> что это
  const syns = new Map(); // синоним (lower) -> владелец
  const reg = (kind, owner) => `${kind} "${owner}"`;

  for (const d of m.dimensions ?? []) {
    const w = `${where} · измерение ${d.name ?? '?'}`;
    if (!d.name || !d.label) { err(w, 'обязательны name и label'); continue; }
    if (d.type && !DIM_TYPES.has(d.type)) err(w, `неизвестный type "${d.type}"`);
    if (names.has(d.name)) err(w, `имя "${d.name}" уже занято (${names.get(d.name)})`);
    names.set(d.name, reg('измерение', d.name));
    if (d.sql) checkSqlRefs(w, d.sql);
    for (const t of d.requires_join ?? []) {
      if (!relatedTables.has(t)) err(w, `requires_join: таблица "${t}" не фигурирует в relationships.yaml`);
    }
    for (const s of d.synonyms ?? []) {
      const key = s.trim().toLowerCase();
      if (syns.has(key)) err(w, `синоним "${s}" уже занят (${syns.get(key)})`);
      syns.set(key, reg('измерение', d.name));
    }
  }

  for (const me of m.measures ?? []) {
    const w = `${where} · мера ${me.name ?? '?'}`;
    if (!me.name || !me.label) { err(w, 'обязательны name и label'); continue; }
    if (!MEASURE_TYPES.has(me.type ?? 'simple')) err(w, `неизвестный type "${me.type}"`);
    if (names.has(me.name)) err(w, `имя "${me.name}" уже занято (${names.get(me.name)}); компилятор найдёт измерение, мера недостижима`);
    names.set(me.name, reg('мера', me.name));

    if ((me.type ?? 'simple') === 'ratio') {
      if (!me.numerator_sql || !me.denominator_sql) err(w, 'ratio требует numerator_sql и denominator_sql');
      if (me.numerator_sql) checkSqlRefs(w, me.numerator_sql);
      if (me.denominator_sql) checkSqlRefs(w, me.denominator_sql);
    } else {
      if (!me.sql) err(w, `нет sql (type "${me.type ?? 'simple'}")`);
      else checkSqlRefs(w, me.sql);
    }
    if (me.type === 'latest_snapshot') {
      if (!me.snapshot_key || !me.order_by) err(w, 'latest_snapshot требует snapshot_key и order_by');
      if (me.snapshot_key) checkRefsOnly(w, me.snapshot_key);
      if (me.order_by) checkRefsOnly(w, me.order_by);
    }
    for (const t of me.requires_join ?? []) {
      if (!relatedTables.has(t)) err(w, `requires_join: таблица "${t}" не фигурирует в relationships.yaml`);
    }
    for (const s of me.synonyms ?? []) {
      const key = s.trim().toLowerCase();
      if (syns.has(key)) err(w, `синоним "${s}" уже занят (${syns.get(key)})`);
      syns.set(key, reg('мера', me.name));
    }
  }
}

// ---------- сверка domain с БД ----------

// Измерение -> физическая колонка для SELECT DISTINCT:
// без sql — physical.table.name; sql вида "table.column" — как написано.
// Выражения (to_char(...), конкатенация) сверять нечем — пропускаем.
function domainColumn(m, d) {
  if (!d.sql) return { table: m.physical?.table, column: d.name };
  const mm = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i.exec(d.sql.trim());
  return mm ? { table: mm[1], column: mm[2] } : null;
}

const quoteIdent = (id) => `"${String(id).replace(/"/g, '""')}"`;
const domainChecks = [];
for (const m of models) {
  for (const d of m.dimensions ?? []) {
    if (!d.domain?.length) continue;
    const col = domainColumn(m, d);
    if (!col) {
      warn(m.__file, `измерение ${d.name}: sql — выражение, домен "${d.domain.length} знач." сверен не будет`);
      continue;
    }
    domainChecks.push({ where: `${m.__file} · измерение ${d.name}`, ...col, domain: d.domain });
  }
}

let pool = null;
const requireDb = process.argv.includes('--require-db');
if (domainChecks.length) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/qlik_table',
    max: 1,
    connectionTimeoutMillis: 3000,
    options: '-c default_transaction_read_only=on -c statement_timeout=15000',
  });
  pool.on('error', () => {});
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    const msg = `БД недоступна (${e.message.code ?? e.message}) — сверка domain пропущена`;
    if (requireDb) errors.push(msg);
    else warnings.push(`${msg}; --require-db превратит пропуск в ошибку`);
    await pool.end().catch(() => {});
    pool = null;
  }
}

if (pool) {
  for (const c of domainChecks) {
    let dbValues;
    try {
      const r = await pool.query(`SELECT DISTINCT ${quoteIdent(c.column)} AS v FROM ${quoteIdent(c.table)}`);
      dbValues = new Set(r.rows.map((row) => String(row.v)));
    } catch (e) {
      err(c.where, `SELECT DISTINCT не выполнился: ${e.message}`);
      continue;
    }
    for (const v of c.domain) {
      if (!dbValues.has(String(v))) err(c.where, `значение домена ${JSON.stringify(v)} отсутствует в ${c.table}.${c.column}`);
    }
    for (const v of dbValues) {
      if (!c.domain.some((d) => String(d) === v)) err(c.where, `в ${c.table}.${c.column} есть значение ${JSON.stringify(v)}, которого нет в domain`);
    }
  }
  await pool.end().catch(() => {});
}

// ---------- итог ----------

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`\nпроверено моделей: ${models.length}, связей: ${relationships.length}, доменов сверено: ${pool ? domainChecks.length : 0}`);
if (errors.length) {
  console.log(`ОШИБОК: ${errors.length}`);
  process.exit(1);
}
console.log('OK');
