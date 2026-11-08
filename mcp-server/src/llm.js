// Клиент Moonshot/Kimi (OpenAI-совместимый chat completions) + устойчивый разбор JSON-ответа.
// Модель produceирует ПЛАН (IR), а не SQL: SQL детерминированно компилируется из плана (compiler.js).

import { traceStep } from './trace.js';

function buildSystemPrompt(schemaText, semanticBlock = '', examplesBlock = '') {
  const semanticSection = semanticBlock
    ? `\n${semanticBlock}\n`
    : '';
  const examplesSection = examplesBlock
    ? `\n${examplesBlock}\n`
    : '';
  return `Ты переводишь вопросы на русском языке в ПЛАНЫ запросов (IR) к базе финансовой отчётности девелопера (застройщика жилой недвижимости), PostgreSQL 16. SQL ты НЕ пишешь: план детерминированно компилируется в SQL сервером.

План — строгий JSON-объект:
{
  "from": "<имя модели-факта из семантического ядра>",
  "select": [
    {"ref": "<измерение или мера>", "alias": "<snake_case>", "scale": 1000000, "round": 1}
  ],
  "where": [
    {"ref": "<измерение или мера>", "op": "=", "value": "..."}
  ],
  "group_by": ["<измерение из select>"],
  "order_by": [{"alias": "<алиас из select>", "dir": "asc|desc"}],
  "limit": 10
}

Поля и правила:
- "from" — ровно одна модель-факта (sales, units, sales_plan, construction_progress, cashflow, objects, buildings, channels). Все ref разрешаются внутри этой модели по имени или синониму.
- select: измерения и меры по имени или синониму. Алиасы — осмысленные, на английском, snake_case: channel, revenue_mln, plan_mln.
- scale — делитель для вывода (для «в млн рублей» укажи 1000000); round — число знаков после запятой. Только для мер.
- where: фильтр по измерению уходит в WHERE, по мере — в HAVING. op: =, !=, >, >=, <, <=, in, is_null, is_not_null. Даты — строкой YYYY-MM-DD; список для in — массивом. Значения доменов бери точно как указано в семантическом ядре (в фигурных скобках у измерения).
- Диапазон периода — два фильтра: {"ref": "<дата>", "op": ">=", "value": "YYYY-MM-DD"} и {"ref": "<дата>", "op": "<", "value": "YYYY-MM-DD"} (конец исключительно). «За 2026 год» = от 2026-01-01 до 2027-01-01.
- group_by можно опустить — тогда группировка будет по всем измерениям из select автоматически. Явный group_by — только по измерениям из select.
- order_by — только по алиасам из select. limit — целое положительное.
- Процентные меры (доли, готовность) уже в процентах — scale не указывай.
- Факт продаж за период без сравнения с планом считай по всем доступным месяцам, включая текущий.

Если вопрос нельзя выразить одной моделью-фактом (сравнение плана и факта в одной таблице, факторный анализ, арифметика между мерами разных моделей) — не выдумывай план, ответь:
{"unanswerable": "краткая причина, что не поддержано"}

Отвечай СТРОГО одним JSON-объектом без текста вокруг:
{"plan": {...}, "explanation": "кратко (1 предложение), что считает запрос"}
Переносы строк внутри JSON не допускаются.

Схема БД (физическая, из information_schema):
${schemaText}
${semanticSection}${examplesSection}
Пример:
Вопрос: Продажи по каналам за 2026 год
Ответ: {"plan":{"from":"sales","select":[{"ref":"channel","alias":"channel"},{"ref":"revenue","alias":"revenue_mln","scale":1000000,"round":1}],"where":[{"ref":"sale_date","op":">=","value":"2026-01-01"},{"ref":"sale_date","op":"<","value":"2027-01-01"}],"order_by":[{"alias":"revenue_mln","dir":"desc"}]},"explanation":"Выручка по каналам продаж за 2026 год, млн рублей с одним знаком."}`;
}

function unescapeJsonString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Устойчиво извлекает JSON из ответа модели. */
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
      if (parsed && typeof parsed === 'object') {
        traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: JSON.parse целиком');
        return parsed;
      }
    } catch {
      // переходим к ручному разбору полей
    }
    const planMatch = candidate.slice(start, end + 1).match(/"plan"\s*:\s*(\{(?:\\[\s\S]|[\s\S])*?\})\s*[,}]/);
    if (planMatch) {
      traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: регулярное выделение полей plan/explanation');
      const explMatch = candidate.slice(start, end + 1).match(/"explanation"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
      const unansMatch = candidate.slice(start, end + 1).match(/"unanswerable"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
      let plan;
      try {
        plan = JSON.parse(planMatch[1]);
      } catch {
        plan = JSON.parse(unescapeJsonString(planMatch[1]));
      }
      return {
        plan,
        explanation: explMatch ? unescapeJsonString(explMatch[1]) : '',
        unanswerable: unansMatch ? unescapeJsonString(unansMatch[1]) : undefined,
      };
    }
  }

  traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'не удалось извлечь JSON с планом — будет ошибка');
  throw new Error('Не удалось разобрать ответ модели: ожидался JSON с полем "plan" или "unanswerable".');
}

/**
 * Возвращает {plan?, unanswerable?, explanation?} — сырой (непровалидированный) план.
 * Валидация и компиляция — на стороне сервера (ir.js, compiler.js).
 */
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
            `Твой предыдущий план отклонён компилятором/валидацией. Проблемы: ${correction.problems.join('; ')}. ` +
            `Исправь план: ref — только существующие измерения и меры из модели семантического ядра, ` +
            `значения — строго из доменов, алиасы order_by — из select. ` +
            `Предыдущий (неверный) план: ${JSON.stringify(correction.previousPlan)}. Ответь тем же форматом JSON.`,
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
  const parsed = parseLlmJson(content);
  return {
    plan: parsed.plan,
    unanswerable: parsed.unanswerable,
    explanation: String(parsed.explanation ?? ''),
  };
}
