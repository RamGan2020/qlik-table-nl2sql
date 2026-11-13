// Юнит-тест универсальности компилятора: новые модели/таблицы без правки
// кода (авто-алиасы), защита от fanout (джойн "от одного ко многим"),
// неизменность существующих алиасов. Запуск: node test/compiler-universal.js

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

import { createSemanticLoader } from '../src/semantic.js';
import { compilePlan } from '../src/compiler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = createSemanticLoader(
  join(root, 'src', 'models'),
  join(root, 'src', 'relationships.yaml'),
)();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/qlik_table',
  max: 2,
  options: '-c default_transaction_read_only=on -c statement_timeout=15000',
});
pool.on('error', () => {});

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

function compiles(name, semantic, plan, contains = []) {
  try {
    const sql = compilePlan(plan, semantic);
    const again = compilePlan(plan, semantic);
    check(`${name}: компилируется`, true);
    check(`${name}: детерминизм`, sql === again, `первый: ${sql}\n      второй: ${again}`);
    const missing = contains.filter((s) => !sql.includes(s));
    check(`${name}: содержит ${JSON.stringify(contains)}`, !missing.length, `нет: ${missing.join(', ')}\n      SQL: ${sql}`);
    return sql;
  } catch (e) {
    check(`${name}: компилируется`, false, e.message);
    return null;
  }
}

function refused(name, semantic, plan, fragment) {
  try {
    compilePlan(plan, semantic);
    check(`${name}: отказ`, false, 'ожидался отказ, план скомпилировался');
  } catch (e) {
    check(`${name}: отказ`, e.message.includes(fragment), `ожидалось "${fragment}", получено: ${e.message}`);
  }
}

// --- фикстура: две новые таблицы, о которых compiler.js ничего не знает ---

const paymentsModel = {
  name: 'payments',
  label: 'Платежи (тест)',
  physical: { table: 'payments', primary_key: 'payment_id' },
  dimensions: [
    { name: 'object', label: 'Объект (ЖК)', type: 'string', sql: 'objects.name', requires_join: ['objects'] },
    { name: 'month', label: 'Месяц платежа', type: 'date' },
  ],
  measures: [{ name: 'amount', label: 'Сумма платежа', type: 'simple', sql: 'SUM(payments.amount)' }],
};

const partsModel = {
  name: 'parts',
  label: 'Комплектации (тест)',
  physical: { table: 'parts', primary_key: 'part_id' },
  dimensions: [
    {
      name: 'payment_no',
      label: 'Номер платежа',
      type: 'string',
      sql: 'payments.pay_no',
      requires_join: ['payments'],
    },
  ],
  measures: [{ name: 'parts_count', label: 'Число комплектаций', type: 'simple', sql: 'COUNT(*)' }],
};

const extraRelationships = [
  { from: 'payments.object_id', to: 'objects.object_id', type: 'many_to_one', label: 'Платёж относится к ЖК' },
  { from: 'parts.payment_id', to: 'payments.payment_id', type: 'many_to_one', label: 'Комплектация относится к платежу' },
];

const extended = {
  models: [...base.models, paymentsModel, partsModel],
  relationships: [...base.relationships, ...extraRelationships],
};

// новая таблица получает детерминированный алиас без правки ALIASES
// (parts занимает "pa" — см. следующий тест, поэтому здесь "pay": алиасы
// считаются по всему семантическому слою, а не по таблицам текущего запроса)
compiles('новая модель payments: автоматический алиаз', extended, {
  from: 'payments',
  select: [{ ref: 'object', alias: 'object' }, { ref: 'amount', alias: 'amount' }],
}, ['FROM payments AS pay', 'JOIN objects AS o ON pay.object_id = o.object_id']);

// две новые таблицы с общей первой буквой: алиасы не пересекаются
compiles('две новые таблицы: алиасы pa/pay', extended, {
  from: 'parts',
  select: [{ ref: 'payment_no', alias: 'payment_no' }, { ref: 'parts_count', alias: 'parts_count' }],
}, ['FROM parts AS pa', 'JOIN payments AS pay ON pa.payment_id = pay.payment_id']);

// явный physical.alias в модели имеет приоритет над авто-выводом
{
  const withExplicitAlias = {
    ...extended,
    models: extended.models.map((m) =>
      m.name === 'payments' ? { ...m, physical: { ...m.physical, alias: 'pm' } } : m,
    ),
  };
  compiles('явный physical.alias имеет приоритет', withExplicitAlias, {
    from: 'payments',
    select: [{ ref: 'object', alias: 'object' }, { ref: 'amount', alias: 'amount' }],
  }, ['FROM payments AS pm', 'JOIN objects AS o ON pm.object_id = o.object_id']);
}

// защита от fanout: запрос от units к reservations идёт "от одного ко многим"
{
  const unitsWithReservations = {
    ...extended,
    models: extended.models.map((m) =>
      m.name !== 'units'
        ? m
        : {
            ...m,
            dimensions: [
              ...m.dimensions,
              {
                name: 'reservation_status',
                label: 'Статус брони квартиры',
                type: 'string',
                sql: 'reservations.status',
                requires_join: ['reservations'],
              },
            ],
          },
    ),
  };
  refused(
    'fanout: units -> reservations отклонён',
    unitsWithReservations,
    {
      from: 'units',
      select: [{ ref: 'unit_number', alias: 'unit' }, { ref: 'available_units', alias: 'available_units' }],
      where: [{ ref: 'reservation_status', op: '=', value: 'active' }],
    },
    'умножит строки',
  );
  // обратное направление (многие -> один) — законно
  const sql = compiles('обратное направление reservations -> channels компилируется', extended, {
    from: 'reservations',
    select: [{ ref: 'channel', alias: 'channel' }, { ref: 'reservations_count', alias: 'reservations' }],
  }, ['FROM reservations AS r', 'JOIN channels AS c ON r.channel_id = c.channel_id']);
  if (sql) {
    try {
      const { rows } = await pool.query(sql);
      check('обратное направление: выполняется на БД', rows.length >= 1, `строк: ${rows.length}`);
    } catch (e) {
      check('обратное направление: выполняется на БД', false, `${e.message}\n      SQL: ${sql}`);
    }
  }
}

// регрессия: существующие алиасы не изменились
{
  const sql = compiles('существующие алиасы не изменились', base, {
    from: 'sales',
    select: [{ ref: 'channel', alias: 'channel' }, { ref: 'revenue', alias: 'revenue' }],
  }, ['FROM sales AS s', 'JOIN channels AS c ON s.channel_id = c.channel_id']);
  if (sql) {
    try {
      await pool.query(sql);
      check('существующие алиасы: выполняется на БД', true);
    } catch (e) {
      check('существующие алиасы: выполняется на БД', false, `${e.message}\n      SQL: ${sql}`);
    }
  }
}

await pool.end().catch(() => {});

console.log(`\n${passed} проверок пройдено.`);
if (failures.length) {
  console.log(`ПРОВАЛЕНО: ${failures.join(', ')}`);
  process.exit(1);
}
