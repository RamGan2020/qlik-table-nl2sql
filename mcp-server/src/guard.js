// Read-only guard: пропускает только одиночные SELECT-подобные запросы.

const ALLOWED_FIRST = /^(select|with|explain|values|table)\b/i;

const FORBIDDEN = new RegExp(
  '\\b(' + [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
    'grant', 'revoke', 'copy', 'call', 'do', 'vacuum', 'reindex', 'refresh',
    'notify', 'listen', 'lock', 'into',          // SELECT ... INTO создаёт таблицу
  ].join('|') + ')\\b',
  'i',
);

/**
 * Проверяет, что запрос безопасен для read-only выполнения.
 * Возвращает очищенный SQL (без комментариев и финальных ';').
 * Бросает Error с пояснением, если запрос отклонён.
 */
export function normalizeReadOnly(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new Error('Пустой SQL-запрос.');
  }
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .trim();

  if (!ALLOWED_FIRST.test(cleaned)) {
    throw new Error('Разрешены только SELECT/WITH/EXPLAIN/VALUES/TABLE-запросы (read-only).');
  }
  if (FORBIDDEN.test(cleaned)) {
    throw new Error('Запрос содержит запрещённые конструкции (INSERT/UPDATE/DELETE/DDL/INTO и т.п.).');
  }
  if (cleaned.includes(';')) {
    throw new Error('Разрешён только одиночный запрос (без «;» внутри текста).');
  }
  return cleaned;
}
