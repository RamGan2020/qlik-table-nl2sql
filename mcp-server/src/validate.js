// Пост-валидация сгенерированного SQL: извлекаем таблицы и ссылки alias.column
// и проверяем их существование в семантическом слое / физической схеме,
// а пары колонок джойнов — против реестра связей (relationships.yaml).
// Находка = сигнал галлюцинации LLM -> повторный запрос.

const KEYWORDS = new Set([
  'where', 'on', 'group', 'order', 'left', 'right', 'inner', 'full', 'cross',
  'join', 'using', 'limit', 'having', 'union', 'as', 'select', 'when', 'then',
  'else', 'end', 'and', 'or', 'not', 'null', 'in', 'is', 'case', 'over',
  'partition', 'between', 'like', 'asc', 'desc', 'filter', 'within', 'distinct',
  'from', 'with', 'natural', 'lateral',
]);

function stripStringsAndComments(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, ' ');
}

export function extractEntities(sql) {
  const text = stripStringsAndComments(sql);

  // CTE: "name AS (" — такие имена не проверяем как таблицы
  const ctes = new Set();
  for (const m of text.matchAll(/\b([a-zA-Z_]\w*)\s+AS\s*\(/gi)) ctes.add(m[1].toLowerCase());

  // Таблицы и алиасы из FROM/JOIN; после FROM список может продолжаться запятыми: FROM a, b, c
  const tables = [];
  const aliasMap = new Map(); // alias -> table
  const re = /\b(FROM|JOIN)\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi;
  const addTable = (table, alias) => {
    tables.push(table);
    if (alias && !KEYWORDS.has(alias.toLowerCase())) {
      aliasMap.set(alias.toLowerCase(), table.toLowerCase());
    }
    aliasMap.set(table.toLowerCase(), table.toLowerCase());
  };
  for (const m of text.matchAll(re)) {
    addTable(m[2], m[3]);
    if (m[1].toUpperCase() !== 'FROM') continue;
    let rest = text.slice(m.index + m[0].length);
    const itemRe = /^\s*,\s*([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/;
    let im;
    while ((im = rest.match(itemRe))) {
      addTable(im[1], im[2]);
      rest = rest.slice(im[0].length);
    }
  }

  // Ссылки alias.column / table.column
  const refs = [];
  for (const m of text.matchAll(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)/g)) {
    refs.push({ qualifier: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }

  return { ctes, tables, aliasMap, refs };
}

// ---- Проверка пар колонок джойнов против реестра связей (relationships.yaml) ----

function pairKey(tableA, colA, tableB, colB) {
  const l = `${tableA}.${colA}`;
  const r = `${tableB}.${colB}`;
  return l < r ? `${l}|${r}` : `${r}|${l}`;
}

// relationships: [{from: 'sales.unit_id', to: 'units.unit_id', ...}]
// -> { pairs: Set "t.c|t.c" (неупорядоченно), relCols: Map<table, Set<column>> }
function buildRelationshipIndex(relationships) {
  const pairs = new Set();
  const relCols = new Map();
  for (const r of relationships ?? []) {
    const [ft, fc] = String(r.from ?? '').toLowerCase().split('.');
    const [tt, tc] = String(r.to ?? '').toLowerCase().split('.');
    if (!ft || !fc || !tt || !tc) continue;
    pairs.add(pairKey(ft, fc, tt, tc));
    if (!relCols.has(ft)) relCols.set(ft, new Set());
    if (!relCols.has(tt)) relCols.set(tt, new Set());
    relCols.get(ft).add(fc);
    relCols.get(tt).add(tc);
  }
  return { pairs, relCols };
}

/**
 * Каждое равенство alias.column = alias.column в ON/WHERE — предикат джойна;
 * пара таблиц должна быть объявлена в relationships.yaml. USING (col) проверяем
 * по колонкам реестра. Неразрешимое (подзапрос/CTE, самоджойн той же таблицы,
 * выражения) пропускаем, чтобы не ругать то, что не можем верифицировать.
 * Возвращает список проблем (строки).
 */
export function validateJoins(sql, relationships) {
  const { pairs, relCols } = buildRelationshipIndex(relationships);
  if (!pairs.size) return [];
  const { ctes, aliasMap } = extractEntities(sql);
  const problems = new Set();

  const resolve = (qual, col) => {
    const table = aliasMap.get(qual);
    if (!table || ctes.has(table) || ctes.has(qual)) return null; // подзапрос/CTE — не верифицируем
    return { table, col };
  };

  const eqRe = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*=\s*([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)/g;
  for (const m of stripStringsAndComments(sql).matchAll(eqRe)) {
    const left = resolve(m[1].toLowerCase(), m[2].toLowerCase());
    const right = resolve(m[3].toLowerCase(), m[4].toLowerCase());
    if (!left || !right || left.table === right.table) continue; // самоджойн/неразрешимо
    if (pairs.has(pairKey(left.table, left.col, right.table, right.col))) continue;
    const l = `${left.table}.${left.col}`;
    const r = `${right.table}.${right.col}`;
    const [a, b] = l < r ? [l, r] : [r, l]; // детерминированный порядок сторон
    problems.add(
      `JOIN по незадекларированной связи: ${a} = ${b} ` +
      '(такой пары нет в реестре связей семантического ядра — используй только объявленные связи)',
    );
  }

  const usingRe = /\bJOIN\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?\s+USING\s*\(([^)]*)\)/gi;
  for (const m of stripStringsAndComments(sql).matchAll(usingRe)) {
    const table = m[1].toLowerCase();
    if (ctes.has(table)) continue;
    for (const col of m[3].split(',')) {
      const c = col.trim().toLowerCase();
      if (c && !relCols.get(table)?.has(c)) {
        problems.add(`USING (${c}) не соответствует ни одной объявленной связи таблицы "${table}"`);
      }
    }
  }

  return [...problems];
}

/**
 * knownTables: Map<table_lower, Set<column_lower>> — семантический слой
 * объединённый с физической схемой. relationships: записи relationships.yaml
 * (пусто — проверку джойнов пропускаем). Возвращает список проблем (строки).
 */
export function validateSql(sql, knownTables, relationships = []) {
  if (!knownTables || knownTables.size === 0) return [];
  const { ctes, tables, aliasMap, refs } = extractEntities(sql);
  const unknownTables = new Set();
  const badColumns = new Set();

  for (const t of tables) {
    const key = t.toLowerCase();
    if (!ctes.has(key) && !knownTables.has(key)) unknownTables.add(t);
  }

  for (const r of refs) {
    const table = aliasMap.get(r.qualifier) ?? r.qualifier;
    if (ctes.has(table) || ctes.has(r.qualifier)) continue;        // колонки CTE не проверяем
    if (aliasMap.has(r.qualifier)) {
      if (!knownTables.has(table)) {
        unknownTables.add(table);
      } else if (!knownTables.get(table).has(r.column)) {
        badColumns.add(`${r.qualifier}.${r.column}`);
      }
    }
    // алиас неизвестен (подзапрос) — пропускаем, не можем верифицировать
  }

  return [
    ...[...unknownTables].map((t) => `таблица "${t}" не существует в семантическом слое и физической схеме`),
    ...[...badColumns].map((c) => `колонка "${c}" не существует`),
    ...validateJoins(sql, relationships),
  ];
}
