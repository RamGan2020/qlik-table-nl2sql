// Трассировка nl_to_sql: полный лог пути «вопрос -> промпт -> LLM -> разбор -> валидация -> ответ».
// Включается переменной окружения NL2SQL_TRACE (путь к файлу лога); не задана — трассировка выключена.
// Пишем ТОЛЬКО в файл: stdout занят протоколом MCP (stdio).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

// Ленивое разрешение пути: dotenv в index.js отрабатывает после импортов,
// поэтому читать переменную нужно не на этапе загрузки модуля, а при первом вызове.
let target = null; // null — не разрешён; '' — трассировка выключена
let sessionStarted = false;

function resolveTarget() {
  if (target !== null) return target;
  const file = process.env.NL2SQL_TRACE ?? '';
  target = file ? (isAbsolute(file) ? file : resolve(process.cwd(), file)) : '';
  return target;
}

export function initTrace() {
  const t = resolveTarget();
  if (!t) return;
  try {
    mkdirSync(dirname(t), { recursive: true });
  } catch {
    // не мешаем работе сервера
  }
}

export function traceStep(step, body = '') {
  const t = resolveTarget();
  if (!t) return;
  try {
    if (!sessionStarted) {
      appendFileSync(t, `\n########## TRACE SESSION ${new Date().toISOString()} ##########\n`);
      sessionStarted = true;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    appendFileSync(t, `\n----- ${step} -----\n${text}\n`);
  } catch {
    // трассировка не должна ломать сервер
  }
}
