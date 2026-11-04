// Слой метрик (semantic layer): загрузка metrics.json и рендер блока для промпта.
// Автообновление по mtime: аналитик правит файл — следующий вопрос видит новую версию
// без перезапуска сервера. Битый JSON не применяется: остаётся последняя рабочая версия.

import { existsSync, readFileSync, statSync } from 'node:fs';

export function createMetricsLoader(filePath) {
  let cached = null;
  let cachedMtime = 0;

  return function getMetrics() {
    try {
      if (!existsSync(filePath)) return cached;
      const mtime = statSync(filePath).mtimeMs;
      if (cached && mtime === cachedMtime) return cached;
      cached = JSON.parse(readFileSync(filePath, 'utf8'));
      cachedMtime = mtime;
      return cached;
    } catch (e) {
      process.stderr.write(`[metrics] ошибка чтения ${filePath}: ${e.message} — используется последняя рабочая версия\n`);
      return cached;
    }
  };
}

export function renderMetricsBlock(data) {
  if (!data) return '';
  const lines = [];
  if (data.description) {
    lines.push(data.description, '');
  }
  for (const m of data.metrics ?? []) {
    lines.push(`- ${m.name}`);
    if (m.synonyms?.length) lines.push(`  синонимы: ${m.synonyms.join(', ')}`);
    lines.push(`  определение: ${m.definition}`);
    if (m.sql) lines.push(`  канонический SQL: ${m.sql}`);
    if (m.notes) lines.push(`  примечание: ${m.notes}`);
  }
  return lines.join('\n');
}
