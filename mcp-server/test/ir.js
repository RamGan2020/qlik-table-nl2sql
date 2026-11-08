// Юнит-тест схемы IR (src/ir.js): parsePlan принимает валидные планы и
// отклоняет невалидные с понятными причинами. Запуск: node test/ir.js

import { parsePlan } from '../src/ir.js';

let passed = 0;
const failures = [];
function ok(name, fn, fragment) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function accepts(name, raw) {
  ok(name, () => parsePlan(raw));
}
function rejects(name, raw, fragment) {
  ok(name, () => {
    try {
      parsePlan(raw);
    } catch (e) {
      if (!e.message.includes(fragment)) throw new Error(`ожидалось "${fragment}", получено: ${e.message}`);
      return;
    }
    throw new Error('план принят, ожидался отказ');
  });
}

accepts('минимальный план', { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }] });
accepts('полный план', {
  from: 'sales',
  select: [{ ref: 'channel', alias: 'channel' }, { ref: 'revenue', alias: 'revenue_mln', scale: 1000000, round: 1 }],
  where: [{ ref: 'sale_date', op: '>=', value: '2026-01-01' }],
  group_by: ['channel'],
  order_by: [{ alias: 'revenue_mln', dir: 'desc' }],
  limit: 10,
  note: 'тест',
});

// регрессия: элементы подпланов с ref не должны терять ref при zod-union
{
  const plan = parsePlan({
    with: [
      { name: 'p', from: 'sales', select: [{ ref: 'deals', alias: 'deals' }], where: [{ ref: 'sale_date', op: '>=', value: '2026-01-01' }] },
      { name: 'c', from: 'channels', select: [{ ref: 'name', alias: 'channel' }] },
    ],
    join: [{ cte: 'p' }, { cte: 'c', type: 'cross' }],
    select: [{ cte: 'p', col: 'deals', alias: 'deals' }],
  });
  const ok = plan.with[0].select[0].ref === 'deals' && plan.with[1].select[0].ref === 'name';
  if (ok) { passed++; console.log('PASS  подпланы: ref элементов сохраняется после парсинга'); }
  else { failures.push('subplan-ref'); console.log('FAIL  подпланы: ref элементов сохраняется\n      получено:', JSON.stringify(plan.with)); }
}

rejects('пустой select', { from: 'sales', select: [] }, 'select');
rejects('неизвестный ключ', { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }], having: [] }, 'having');
rejects('плохой алиас', { from: 'sales', select: [{ ref: 'deals', alias: 'Deals!' }] }, 'alias');
rejects('плохой op', { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }], where: [{ ref: 'x', op: 'like', value: 'y' }] }, 'op');
rejects('limit = 0', { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }], limit: 0 }, 'limit');
rejects('select не массив', { from: 'sales', select: 'deals' }, 'select');
rejects('order_by без alias', { from: 'sales', select: [{ ref: 'deals', alias: 'deals' }], order_by: [{ dir: 'asc' }] }, 'alias');

console.log(`\n${passed} проверок пройдено${failures.length ? `, ${failures.length} упало` : ''}.`);
if (failures.length) process.exitCode = 1;
