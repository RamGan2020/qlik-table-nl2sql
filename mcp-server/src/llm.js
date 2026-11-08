// Клиент Moonshot/Kimi (OpenAI-совместимый chat completions) + устойчивый разбор JSON-ответа.

import { traceStep } from './trace.js';

function buildSystemPrompt(schemaText, semanticBlock = '', examplesBlock = '') {
  const semanticSection = semanticBlock
    ? `\n${semanticBlock}\n`
    : '';
  const examplesSection = examplesBlock
    ? `\n${examplesBlock}\n`
    : '';
  return `Ты переводишь вопросы на русском языке в SQL-запросы для PostgreSQL 16. База — финансовая отчётность девелопера (застройщика жилой недвижимости).

Как работать с семантическим слоем: сначала определи, какие метрики, измерения и фильтры соответствуют вопросу, используя предоставленный ниже фрагмент семантического слоя. Затем сгенерируй SQL, используя физические имена таблиц и колонок из определений. Используй только сущности, которые существуют в семантическом слое или физической схеме — выдуманные таблицы и колонки недопустимы.

Схема БД (физическая, из information_schema):
${schemaText}
${semanticSection}${examplesSection}
Ключевые правила (дополняют семантическое ядро):
- «Факт vs план» продаж: факт — мера revenue из модели sales по месяцу date_trunc('month', sale_date), план — мера planned_revenue из модели sales_plan по month. При сравнении факта с планом за период, включающий текущий месяц, факт ограничивай ЗАКРЫТЫМИ месяцами (< date_trunc('month', CURRENT_DATE)), чтобы не сравнивать неполный месяц с полным планом. Вопросы про факт за период без сравнения с планом считай по всем доступным месяцам, включая текущий.
- Денежные суммы — рубли; для ответа в миллионах делить на 1e6 и округлять round(x, 1), если вопрос не задаёт другой формат.
- Имена объектов и каналов — точно как в данных, в одинарных кавычках: 'ЖК «Заречный»'.
- Домены значений: objects.status — 'строится' / 'сдан'; units.status — 'available' / 'sold' / 'reserved'; sales.contract — 'ДДУ' / 'Уступка права' / 'Рассрочка'.

Жёсткие правила:
1. Только одиночный SELECT (допускается WITH). Запрещены INSERT/UPDATE/DELETE/DDL и любые изменения данных.
2. Отвечай СТРОГО одним JSON-объектом без текста вокруг:
{"sql":"...","explanation":"кратко (1 предложение), что считает запрос"}
3. Внутри JSON переносы строк экранируй как \\n.
4. Алиасы колонок — осмысленные, на английском: month, plan_mln, fact_mln и т.п.
5. Все суммы, разности и эффекты факторного анализа считай внутри SQL (sum, CTE, оконные функции), НЕ арифметикой в тексте ответа. Текст объяснения — только интерпретация готовых чисел из запроса.
6. При факторном разложении каждый шаг — отдельной колонкой результата (значение фактора, млн), чтобы было видно, из чего сложилось итоговое отклонение.

Пример:
Вопрос: Продажи по каналам за 2026 год
Ответ: {"sql":"SELECT c.name AS channel, count(*) AS deals, round(sum(s.price) / 1e6, 1) AS revenue_mln FROM sales s JOIN channels c ON c.channel_id = s.channel_id WHERE s.sale_date >= DATE '2026-01-01' AND s.sale_date < DATE '2027-01-01' GROUP BY c.name ORDER BY revenue_mln DESC","explanation":"Выручка и число сделок по каналам за 2026 год."}`;
}

function unescapeJsonString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Устойчиво извлекает {sql, explanation} из ответа модели. */
export function parseLlmJson(text) {
  // 1) попытка выделить JSON-блок из ```json ... ``` или {...}
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed.sql === 'string' && parsed.sql.trim()) {
        traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: JSON.parse целиком');
        return { sql: parsed.sql.trim(), explanation: String(parsed.explanation ?? '') };
      }
    } catch {
      // переходим к ручному разбору полей
    }
    const sqlMatch = candidate.slice(start, end + 1).match(/"sql"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
    if (sqlMatch) {
      traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: регулярное выделение полей sql/explanation');
      const explMatch = candidate.slice(start, end + 1).match(/"explanation"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
      return {
        sql: unescapeJsonString(sqlMatch[1]).trim(),
        explanation: explMatch ? unescapeJsonString(explMatch[1]) : '',
      };
    }
  }

  // 2) последняя надежда: в тексте просто лежит SQL
  if (/\bselect\b/i.test(candidate)) {
    traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: в ответе голый SQL без JSON, explanation оставлен пустым');
    return { sql: candidate, explanation: '' };
  }
  traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'не удалось извлечь JSON с полем "sql" — будет ошибка');
  throw new Error('Не удалось разобрать ответ модели: ожидался JSON с полем "sql".');
}

export async function callNlToSql({ apiKey, baseUrl, model, schemaText, question, temperature = 1, semanticBlock = '', examplesBlock = '', correction = null }) {
  const startedAt = Date.now();
  const system = buildSystemPrompt(schemaText, semanticBlock, examplesBlock);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: question },
    ...(correction
      ? [{
          role: 'user',
          content:
            `Твой предыдущий ответ отклонён валидацией. Проблемы: ${correction.problems.join('; ')}. ` +
            `Исправь SQL: сущности бери из семантического слоя и физической схемы, ` +
            `джойны выполняй только по связям из реестра связей семантического ядра. ` +
            `Предыдущий (неверный) SQL: ${correction.previousSql}. Ответь тем же форматом JSON.`,
        }]
      : []),
  ];

  traceStep(
    correction ? 'LLM ЗАПРОС (исправляющий повтор)' : 'LLM ЗАПРОС',
    `POST ${baseUrl}/chat/completions\nmodel: ${model}\ntemperature: ${temperature}\n\n` +
      messages.map((m, i) => `== message[${i}] ${m.role} ==\n${m.content}`).join('\n\n'),
  );

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, temperature, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    traceStep('LLM ОШИБКА', `HTTP ${res.status}: ${body.slice(0, 300)}`);
    throw new Error(`Moonshot API вернул ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const content = message.content;
  if (!content) throw new Error('Пустой ответ Moonshot API.');
  if (message.reasoning_content) {
    traceStep('LLM РАССУЖДЕНИЕ (reasoning_content)', String(message.reasoning_content));
  }
  traceStep(
    'LLM СЫРОЙ ОТВЕТ',
    `${content}\n\nHTTP ${res.status} · ${Date.now() - startedAt} мс` +
      (data.usage ? `\nusage: ${JSON.stringify(data.usage)}` : ''),
  );
  return parseLlmJson(content);
}
