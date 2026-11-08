// Few-shot примеры для системного промпта: вопросы и эталонные SQL из eval/questions.json.
// Автоперечитывание по mtime: аналитик добавляет кейс — следующий вопрос его уже видит.
// Битый JSON не применяется: остаётся последняя рабочая версия, предупреждение в stderr.

import { existsSync, readFileSync, statSync } from 'node:fs';

export function createExamplesLoader(file) {
  let cached = null; // { list: [{question, sql, level}], raw: string }
  let mtime = 0;

  return function getExamples() {
    try {
      const ms = existsSync(file) ? statSync(file).mtimeMs : 0;
      if (cached && ms === mtime) return cached;
      const raw = existsSync(file) ? readFileSync(file, 'utf8') : '[]';
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
            .filter((c) => c && typeof c.question === 'string' && typeof c.reference_sql === 'string'
              && c.question.trim() !== '' && c.reference_sql.trim() !== '')
            .map((c) => ({ question: c.question, sql: c.reference_sql, level: c.level ?? 9 }))
        : [];
      cached = { list, raw };
      mtime = ms;
      return cached;
    } catch (e) {
      process.stderr.write(`[examples] ошибка загрузки ${file}: ${e.message} — используется последняя рабочая версия\n`);
      return cached ?? { list: [], raw: '' };
    }
  };
}

// Блок для системного промпта; '' — примеров нет или они выключены.
export function renderExamplesBlock(loaded) {
  if (!loaded?.list?.length) return '';
  const items = [...loaded.list].sort((a, b) => a.level - b.level); // от простых к сложным
  const L = [];
  L.push('ПРИМЕРЫ ВОПРОСОВ И ЭТАЛОННЫЕ SQL из этого проекта. Это справка по стилю данных —');
  L.push('алиасы, форматы чисел, фильтры дат, цепочки JOIN. Формат твоего ответа — ПЛАН (IR),');
  L.push('не SQL: собери план по правилам выше, эти примеры лишь показывают, какие SQL');
  L.push('ожидаются от компилятора.');
  for (const c of items) {
    L.push('', `Вопрос: ${c.question}`, `SQL: ${c.sql}`);
  }
  return L.join('\n');
}
