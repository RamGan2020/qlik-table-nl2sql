// Юнит-тест разбора ответов модели (parseLlmJson): обёрнутый план, план без
// обёртки, fenced-блок, дважды экранированный JSON, неразбериха.
// Запуск: node test/parse-llm.js

import { parseLlmJson } from '../src/llm.js';

const PLAN = { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }] };

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function check(name, fn, expect) {
  try {
    const r = fn();
    if ('error' in expect) ok(name, false, `ожидалась ошибка "${expect.error}", получен результат`);
    else ok(name, JSON.stringify(r.plan) === JSON.stringify(expect.plan) && (r.explanation ?? '') === (expect.explanation ?? ''), JSON.stringify(r));
  } catch (e) {
    if ('error' in expect) ok(name, e.message.includes(expect.error), `ожидалось "${expect.error}", получено: ${e.message}`);
    else ok(name, false, `неожиданная ошибка: ${e.message}`);
  }
}

check('обёрнутый план', () => parseLlmJson(JSON.stringify({ plan: PLAN, explanation: 'тест' })), { plan: PLAN, explanation: 'тест' });
check('план без обёртки', () => parseLlmJson(JSON.stringify({ ...PLAN, explanation: 'тест' })), { plan: PLAN, explanation: 'тест' });
check('fenced json-блок', () => parseLlmJson('```json\n' + JSON.stringify({ plan: PLAN, explanation: 'т' }) + '\n```'), { plan: PLAN, explanation: 'т' });
check('дважды экранированный JSON', () => parseLlmJson(JSON.stringify(JSON.stringify({ plan: PLAN, explanation: 'т' }))), { plan: PLAN, explanation: 'т' });
check('unanswerable', () => parseLlmJson(JSON.stringify({ unanswerable: 'не поддержано' })).unanswerable, { plan: undefined });
check('мусор — дружелюбная ошибка', () => parseLlmJson('просто текст без JSON'), { error: 'Не удалось разобрать ответ модели' });
check('обрезанный JSON — дружелюбная ошибка', () => parseLlmJson('{"plan":{"from":"sales","select":[{"ref":"deals"'), { error: 'Не удалось разобрать ответ модели' });

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
