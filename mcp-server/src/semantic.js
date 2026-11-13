// Семантическое ядро: загрузка YAML-моделей из src/models/*.yaml + src/relationships.yaml
// и рендер блока для системного промпта.
//
// Автообновление по отпечатку (имена + mtime файлов): аналитик правит модели —
// следующий вопрос видит новую версию без перезапуска. Битый YAML не применяется:
// остаётся последняя рабочая версия, предупреждение в stderr.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

function computeFingerprint(modelsDir, relationshipsFile) {
  try {
    const parts = [];
    if (existsSync(modelsDir)) {
      for (const f of readdirSync(modelsDir).filter((x) => x.endsWith('.yaml')).sort()) {
        parts.push(`${f}:${statSync(join(modelsDir, f)).mtimeMs}`);
      }
    }
    if (existsSync(relationshipsFile)) {
      parts.push(`relationships.yaml:${statSync(relationshipsFile).mtimeMs}`);
    }
    return parts.join('|');
  } catch {
    return '';
  }
}

export function createSemanticLoader(modelsDir, relationshipsFile) {
  let cached = null;
  let fingerprint = '';

  return function getSemantic() {
    try {
      const fp = computeFingerprint(modelsDir, relationshipsFile);
      if (cached && fp && fp === fingerprint) return cached;

      const models = [];
      if (existsSync(modelsDir)) {
        for (const f of readdirSync(modelsDir).filter((x) => x.endsWith('.yaml')).sort()) {
          const m = YAML.parse(readFileSync(join(modelsDir, f), 'utf8'));
          if (m?.name) models.push(m);
        }
      }
      const relsRaw = existsSync(relationshipsFile)
        ? YAML.parse(readFileSync(relationshipsFile, 'utf8'))
        : {};
      cached = { models, relationships: relsRaw.relationships ?? [] };
      fingerprint = fp;
      return cached;
    } catch (e) {
      process.stderr.write(`[semantic] ошибка загрузки моделей: ${e.message} — используется последняя рабочая версия\n`);
      return cached;
    }
  };
}

function renderMeasure(me) {
  let formula = me.sql;
  if (me.type === 'ratio') formula = `${me.numerator_sql} / ${me.denominator_sql}`;
  const parts = [`мера ${me.name} = ${formula} — ${me.label}.`];
  if (me.synonyms?.length) parts.push(`Синонимы: ${me.synonyms.join(', ')}.`);
  if (me.requires_join?.length) parts.push(`Требует JOIN: ${me.requires_join.join(', ')}.`);
  if (me.type === 'latest_snapshot') {
    parts.push(`Тип "последний срез": актуальное значение "${me.sql}" внутри каждого "${me.snapshot_key}" (по ${me.order_by}). Выбирай эту меру для вопросов про текущее состояние; по месяцам её не суммировать и не усреднять.`);
  }
  if (me.notes) parts.push(`Важно: ${me.notes}`);
  return '- ' + parts.join(' ');
}

export function renderSemanticBlock(semantic) {
  if (!semantic || !semantic.models?.length) return '';
  const L = [];
  L.push('СЕМАНТИЧЕСКОЕ ЯДРО — единственный источник истины о данных. Используй модели, меры и связи ниже;');
  L.push('SQL меры считай каноническим, не меняй формулу; выбирай меру по названию или синонимам.');

  for (const m of semantic.models) {
    L.push('', `### Модель "${m.name}" — ${m.label}`);
    if (m.description) L.push(m.description);
    L.push(`Таблица: ${m.physical?.table} (первичный ключ: ${m.physical?.primary_key}).`);
    if (m.dimensions?.length) {
      const dims = m.dimensions.map((d) => {
        const syn = d.synonyms?.length ? ` [синонимы: ${d.synonyms.join(', ')}]` : '';
        const domain = d.domain?.length ? ` {значения: ${d.domain.map((v) => JSON.stringify(v)).join(', ')}}` : '';
        const notes = d.notes ? ` Важно: ${d.notes}` : '';
        return `${d.name} (${d.type}) — ${d.label}${syn}${domain}${notes}`;
      });
      L.push(`Измерения: ${dims.join('; ')}.`);
    }
    for (const me of m.measures ?? []) L.push(renderMeasure(me));
  }

  if (semantic.relationships.length) {
    L.push('', 'СВЯЗИ МЕЖДУ ТАБЛИЦАМИ (используй для JOIN):');
    for (const r of semantic.relationships) {
      const role = r.role === 'calendar' ? ' [календарная связь: джойнить по дате/месяцу]' : '';
      const label = r.label ? ` — ${r.label}` : '';
      L.push(`- ${r.from} -> ${r.to} (${r.type})${label}${role}`);
    }
  }
  return L.join('\n');
}
