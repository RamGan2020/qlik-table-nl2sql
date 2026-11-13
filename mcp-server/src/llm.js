// Клиент Moonshot/Kimi (OpenAI-совместимый chat completions) + устойчивый разбор JSON-ответа.
// Модель produceирует ПЛАН (IR), а не SQL: SQL детерминированно компилируется из плана (compiler.js).

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { traceStep } from './trace.js';

// Системный промпт вынесен в редактируемый файл (как модели YAML): правка
// применяется со следующего запроса без перезапуска — перечитывание по mtime.
// В файле три подставляемых сервером токена: ${schemaText}, ${semanticSection},
// ${examplesSection}.
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'system-prompt.md');
let promptCache = { mtime: 0, text: '' };

function loadPromptTemplate() {
  let mtime;
  try {
    mtime = statSync(PROMPT_FILE).mtimeMs;
  } catch (e) {
    throw new Error(`системный промпт не найден: ${PROMPT_FILE} (${e.message})`);
  }
  if (promptCache.text && mtime === promptCache.mtime) return promptCache.text;
  const text = readFileSync(PROMPT_FILE, 'utf8').replace(/\s+$/u, '');
  promptCache = { mtime, text };
  return text;
}

export function buildSystemPrompt(schemaText, semanticBlock = '', examplesBlock = '') {
  const semanticSection = semanticBlock ? `\n${semanticBlock}\n` : '';
  const examplesSection = examplesBlock ? `\n${examplesBlock}\n` : '';
  // замена функцией- replacer'ом: $-последовательности в подставляемом тексте
  // (DDL схемы) не трактуются как групповые ссылки String.replace
  return loadPromptTemplate()
    .replace('${schemaText}', () => schemaText)
    .replace('${semanticSection}', () => semanticSection)
    .replace('${examplesSection}', () => examplesSection);
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
export async function callNlToSql({ apiKey, baseUrl, model, schemaText, question, temperature = 0, seed = 42, semanticBlock = '', examplesBlock = '', correction = null }) {
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
    `POST ${baseUrl}/chat/completions\nmodel: ${model}\ntemperature: ${temperature}\nseed: ${seed}\n\n` +
      messages.map((m, i) => `== message[${i}] ${m.role} ==\n${m.content}`).join('\n\n'),
  );

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, temperature, seed, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    traceStep('LLM ОШИБКА', `HTTP ${res.status}: ${body.slice(0, 300)}`);
    // coding-endpoint Kimi допускает только temperature=1: откатываемся один раз
    if (res.status === 400 && /temperature/.test(body) && temperature !== 1) {
      traceStep('LLM: temperature отклонена endpointом', `повтор с temperature=1 (seed сохраняется)`);
      return callNlToSql({ apiKey, baseUrl, model, schemaText, question, temperature: 1, seed, semanticBlock, examplesBlock, correction });
    }
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
