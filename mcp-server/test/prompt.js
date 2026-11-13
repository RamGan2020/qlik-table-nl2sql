// Юнит-тест системного промпта: шаблон грузится из prompts/system-prompt.md,
// токены ${schemaText}/${semanticSection}/${examplesSection} подставляются.
// Запуск: node test/prompt.js (без БД и LLM)

import { buildSystemPrompt } from '../src/llm.js';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const SCHEMA = 'SCHEMA_MARKER_7f3a';
const SEMANTIC = 'SEMANTIC_MARKER_9c1e';
const EXAMPLES = 'EXAMPLES_MARKER_4b2d';

const full = buildSystemPrompt(SCHEMA, SEMANTIC, EXAMPLES);
check('подстановка schemaText', full.includes(SCHEMA));
check('подстановка semanticSection', full.includes(SEMANTIC));
check('подстановка examplesSection', full.includes(EXAMPLES));
check('все токены заменены', !full.includes('${schemaText}') && !full.includes('${semanticSection}') && !full.includes('${examplesSection}'));
check('промпт начинается с вводной', full.startsWith('Ты переводишь вопросы на русском языке'));

const bare = buildSystemPrompt(SCHEMA, '', '');
check('пустые секции опускаются без undefined', !bare.includes('undefined') && bare.includes(SCHEMA));

const withDollar = buildSystemPrompt("CREATE TABLE t (c text DEFAULT '$1$&')", '', '');
check('$-последовательности схемы не трогаются', withDollar.includes('$1$&'));

console.log(`\n${passed} проверок пройдено.`);
if (failures.length) {
  console.log(`ПРОВАЛЕНО: ${failures.join(', ')}`);
  process.exit(1);
}
