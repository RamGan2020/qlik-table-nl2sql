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
- Имена объектов, каналов и другие строковые значения из вопроса копируй ПОСИМВОЛЬНО, включая «ёлочки» и регистр: 'ЖК «Заречный»', а не 'Заречный'. Сокращать или переписывать имена нельзя — иначе фильтр не найдёт строки в данных.
- Диапазон периода — два фильтра: {"ref": "<дата>", "op": ">=", "value": "YYYY-MM-DD"} и {"ref": "<дата>", "op": "<", "value": "YYYY-MM-DD"} (конец исключительно). «За 2026 год» = от 2026-01-01 до 2027-01-01.
- group_by можно опустить — тогда группировка будет по всем измерениям из select автоматически. Явный group_by — только по измерениям из select.
- order_by — только по алиасам из select. limit — целое положительное.
- Процентные меры (доли, готовность) уже в процентах — scale не указывай.
- Факт продаж за период без сравнения с планом считай по всем доступным месяцам, включая текущий.

Если вопрос нельзя выразить планом (нужна произвольная логика вне мер/измерений/выражений) — не выдумывай план, ответь:
{"unanswerable": "краткая причина, что не поддержано"}

Сравнение плана и факта, факторный анализ и другие задачи над НЕСКОЛЬКИМИ моделями выражаются подпланами:
{
  "with": [
    {"name": "plan", "from": "sales_plan",
     "select": [{"ref": "object", "alias": "object"}, {"ref": "planned_revenue", "alias": "plan_rev"}],
     "where": [{"ref": "month", "op": ">=", "value": "2026-01-01"}, {"ref": "month", "op": "<", "value": "2027-01-01"}],
     "group_by": ["object"]},
    {"name": "fact", "from": "sales",
     "select": [{"ref": "object", "alias": "object"}, {"ref": "revenue", "alias": "fact_rev"}],
     "where": [{"ref": "sale_date", "op": ">=", "value": "2026-01-01"}, {"ref": "sale_date", "op": "<", "value": "2027-01-01"}],
     "group_by": ["object"]},
    {"name": "objs", "from": "objects", "select": [{"ref": "name", "alias": "object"}]}
  ],
  "join": [{"cte": "objs"},
           {"cte": "plan", "type": "left", "on": [["object", "object"]]},
           {"cte": "fact", "type": "left", "on": [["object", "object"]]}],
  "select": [
    {"cte": "objs", "col": "object", "alias": "object"},
    {"expr": {"fn": "coalesce", "args": [{"cte": "plan", "col": "plan_rev"}, 0]}, "alias": "plan_mln", "scale": 1000000, "round": 1},
    {"expr": {"fn": "coalesce", "args": [{"cte": "fact", "col": "fact_rev"}, 0]}, "alias": "fact_mln", "scale": 1000000, "round": 1}
  ],
  "order_by": [{"alias": "object", "dir": "asc"}]
}
Правила подпланов: каждый with — обычный запрос по одной модели (select/where/group_by); имя подплана = источник колонок для внешнего запроса. join[0] — FROM, остальные соединяются по on: пара [колонка уже введённого подплана, колонка нового]; type: left/right/full/inner/cross (по умолчанию inner). Внешний select: либо {"cte", "col"}, либо {"expr": ...} — выражение из чисел, колонок {"cte","col"}, арифметики {"op":"+|-|*|/","a","b"} и {"fn":"coalesce","args":[...]}. Внешний where — ref вида "подплан.колонка". Процент выполнения плана: {"expr": {"op": "*", "a": 100, "b": {"op": "/", "a": {"cte":"fact","col":"fact_rev"}, "b": {"cte":"plan","col":"plan_rev"}}}, "round": 1}.

Если вопрос требует строки справочника целиком (все каналы или все объекты, включая те, где нет ни плана, ни факта) — подплан-якорь строй от модели-справочника (channels, objects), а не от факт-таблицы: FROM channels -> LEFT JOIN plan -> LEFT JOIN fact. Подплан от факта отсечёт записи справочника без данных.

Деление: знаменатель не оборачивай в coalesce(..., 0) — если он отсутствует, результат должен быть NULL (компилятор сам защищает знаменатель NULLIF, NULL/пропуск корректнее нуля).

План/факт-отчёты: отсутствующую сторону показывай нулём — {"expr": {"fn": "coalesce", "args": [{"cte": "plan", "col": "plan_rev"}, 0]}}. NULL в числовых колонках отчёта недопустим: «не было плана» = 0, а не NULL.

Одиночный расчёт без группировки (факторный анализ и т.п.): подпланы без group_by дают по одной строке и соединяются {"type": "cross"} — декартово произведение строк.

Фильтр «мера против меры» в одиночной модели: value может быть выражением, например
{"ref": "readiness_pct", "op": "<", "value": {"op": "-", "a": {"ref": "planned_readiness_pct"}, "b": 5}}

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

/** Выделяет объект по ключу с балансировкой фигурных скобок (строки учитываются). */
function extractBalanced(text, objKey) {
  const m = text.match(new RegExp(`"${objKey}"\\s*:\\s*\\{`));
  if (!m) return null;
  const start = m.index + m[0].length - 1; // на '{'
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Устойчиво извлекает JSON из ответа модели (в т.ч. дважды экранированный). */
export function parseLlmJson(text) {
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const attempts = [
    ['прямой JSON.parse', () => JSON.parse(candidate)],
    // строка, экранированная как JSON-строка: снимаем слой экранирования
    // и обрамляющие кавычки
    ['JSON с экранированием', () => {
      const un = unescapeJsonString(candidate).trim();
      return JSON.parse(un.startsWith('"') && un.endsWith('"') ? un.slice(1, -1) : un);
    }],
  ];
  for (const [path, fn] of attempts) {
    try {
      const parsed = fn();
      if (parsed && typeof parsed === 'object') {
        // модель может вернуть план БЕЗ обёртки {"plan": ...} — ключи наверху;
        // explanation при этом внутри объекта плана — выделяем его отдельно
        if (!('plan' in parsed) && !('unanswerable' in parsed) && (parsed.from || parsed.with || parsed.select)) {
          traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', `путь: ${path}, план без обёртки — оборачиваем`);
          const { explanation, ...plan } = parsed;
          return { plan, explanation: String(explanation ?? ''), unanswerable: undefined };
        }
        traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', `путь: ${path}`);
        return parsed;
      }
    } catch {
      // следующий путь разбора
    }
  }

  // ручное выделение: plan — балансировкой скобок (на сыром и снятом тексте),
  // остальные поля — regex; каждый шаг под защитой
  const candidates = [candidate, unescapeJsonString(candidate)];
  const explMatch = candidate.match(/"explanation"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
  const unansMatch = candidate.match(/"unanswerable"\s*:\s*"((?:\\[\s\S]|[\s\S])*?)"\s*[,}]/);
  for (const src of candidates) {
    const planText = extractBalanced(src, 'plan');
    if (!planText) continue;
    let plan = null;
    try {
      plan = JSON.parse(planText);
    } catch {
      try {
        plan = JSON.parse(unescapeJsonString(planText));
      } catch {
        plan = null;
      }
    }
    if (plan && typeof plan === 'object') {
      traceStep('РАЗБОР ОТВЕТА МОДЕЛИ', 'путь: выделение plan балансировкой скобок');
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
