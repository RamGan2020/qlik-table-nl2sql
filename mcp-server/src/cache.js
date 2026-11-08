// Кэш сгенерированных SQL: один и тот же вопрос -> тот же ответ (модели coding-endpoint
// принудительно держат temperature=1, поэтому детерминированность даёт кэш, а не сэмплинг).
// Ключ включает вопрос, физическую схему, семантический блок, модель и endpoint:
// смена любой из частей инвалидирует запись автоматически.
// Кэшируется текст SQL (а не результат выполнения), поэтому CURRENT_DATE внутри SQL
// остаётся актуальным при любой дате запуска. Отключить: NL2SQL_CACHE=0.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function createCache(file) {
  let map = null;

  function load() {
    if (map) return map;
    map = new Map();
    if (file && existsSync(file)) {
      try {
        const rows = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(rows)) for (const [k, v] of rows) map.set(k, v);
      } catch {
        // битый файл кэша — начинаем с чистого
      }
    }
    return map;
  }

  function save() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...map.entries()]));
      renameSync(tmp, file); // атомарная замена, чтобы не бояться обрыва записи
    } catch {
      // кэш — оптимизация, не должен ломать генерацию
    }
  }

  return {
    key(parts) {
      return createHash('sha256').update(parts.join('\n')).digest('hex');
    },
    get(k) {
      return load().get(k);
    },
    set(k, v) {
      load().set(k, v);
      save();
    },
  };
}
