// Пост-валидация сгенерированного SQL: извлекаем таблицы и ссылки alias.column
// и проверяем их существование в семантическом слое / физической схеме.
// Находка несуществующей сущности = сигнал галлюцинации LLM -> повторный запрос.

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

  // Таблицы и алиасы из FROM/JOIN
  const tables = [];
  const aliasMap = new Map(); // alias -> table
  const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi;
  for (const m of text.matchAll(re)) {
    const table = m[1];
    tables.push(table);
    const alias = m[2];
    if (alias && !KEYWORDS.has(alias.toLowerCase())) {
      aliasMap.set(alias.toLowerCase(), table.toLowerCase());
    }
    aliasMap.set(table.toLowerCase(), table.toLowerCase());
  }

  // Ссылки alias.column / table.column
  const refs = [];
  for (const m of text.matchAll(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)/g)) {
    refs.push({ qualifier: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }

  return { ctes, tables, aliasMap, refs };
}

/**
 * knownTables: Map<table_lower, Set<column_lower>> — семантический слой
 * объединённый с физической схемой. Возвращает список проблем (строки).
 */
export function validateSql(sql, knownTables) {
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
  ];
}
