// Юнит-тест few-shot загрузчика (src/examples.js): реальный eval/questions.json +
// поведение на временном файле (перечитывание по mtime, битый JSON, отсутствие файла).
// Без БД и LLM. Запуск: node test/examples.js

import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createExamplesLoader, renderExamplesBlock } from '../src/examples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const realFile = join(root, 'eval', 'questions.json');

let passed = 0;
const failures = [];
function expect(cond, name, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// --- реальный eval/questions.json ---
{
  const get = createExamplesLoader(realFile);
  const loaded = get();
  expect(loaded.list.length >= 40, 'реальный questions.json: не меньше 40 примеров', `получено ${loaded.list.length}`);
  const block = renderExamplesBlock(loaded);
  expect(block.includes('ПРИМЕРЫ ВОПРОСОВ'), 'блок начинается с заголовка');
  expect(block.includes('Число сделок по каналам продаж за 2026 год'), 'блок содержит вопрос первого кейса');
  expect(block.includes("FROM sales s JOIN channels c ON c.channel_id = s.channel_id"), 'блок содержит эталонный SQL');
  const firstLevelIdx = block.indexOf('Вопрос:');
  expect(block.slice(firstLevelIdx).includes('Сколько всего квартир продано за весь период'), 'сортировка от простых: ранний уровень-1 кейс в начале');
  expect(renderExamplesBlock({ list: [], raw: '[]' }) === '', 'пустой список -> пустой блок');
}

// --- временный файл: перечитывание, битый JSON, отсутствие ---
{
  const dir = mkdtempSync(join(tmpdir(), 'nl2sql-examples-'));
  const file = join(dir, 'questions.json');
  try {
    writeFileSync(file, JSON.stringify([
      { id: 'a', level: 2, question: 'Вопрос один', reference_sql: 'SELECT 1' },
      { id: 'b', level: 1, question: 'Вопрос два', reference_sql: 'SELECT 2' },
      { id: 'skip', question: '', reference_sql: 'SELECT 3' }, // без question — отфильтрован
    ]));
    const get = createExamplesLoader(file);
    let loaded = get();
    expect(loaded.list.length === 2, 'загрузка: 2 валидных кейса из 3', `получено ${loaded.list.length}`);

    writeFileSync(file, JSON.stringify([{ id: 'c', level: 1, question: 'Вопрос три', reference_sql: 'SELECT 3' }]));
    const { utimesSync } = await import('node:fs');
    utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000)); // гарантированно новый mtime
    loaded = get();
    expect(loaded.list.length === 1 && loaded.list[0].question === 'Вопрос три', 'перечитывание после изменения файла');
    expect(get().raw.includes('Вопрос три'), 'raw для ключа кэша меняется вместе с файлом');

    writeFileSync(file, '{ битый json');
    utimesSync(file, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    loaded = get();
    expect(loaded.list.length === 1 && loaded.list[0].question === 'Вопрос три', 'битый JSON: остаётся последняя рабочая версия');

    const getMissing = createExamplesLoader(join(dir, 'no-such-file.json'));
    expect(getMissing().list.length === 0 && renderExamplesBlock(getMissing()) === '', 'отсутствующий файл: пустой список и пустой блок');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
