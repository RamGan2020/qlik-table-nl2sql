// Детерминированный компилятор: IR (план) -> SQL (PostgreSQL) через polyglot.
//
// Гарантии:
// - SQL строится только из сущностей семантического слоя (меры/измерения/связи);
//   неизвестное — честный отказ, свободный SQL не допускается.
// - Детерминизм: один план -> один и тот же SQL. Алиасы таблиц фиксированы,
//   джойны — обход графа relationships.yaml в порядке BFS с отсортированной
//   адъяцентностью (каждая таблица присоединяется один раз, по ребру от
//   родителя), порядок конструкций — порядок плана.
// - Фрагменты YAML квалифицированы именами таблиц; в SQL они подставляются
//   через AST-проход polyglot (renameTables), поэтому голые колонки
//   не создают неоднозначностей при джойнах.
//
// Вывод проходит parse + generate (polyglot, PostgreSQL-диалект): сбой
// синтаксиса на этом этапе — исключение, некорректный SQL наружу не уходит.

import { parse, generate, Dialect, ast } from '@polyglot-sql/sdk';

// Фиксированные алиасы таблиц (детерминизм + совместимость с примерами).
export const ALIASES = {
  objects: 'o',
  buildings: 'b',
  channels: 'c',
  units: 'u',
  sales: 's',
  sales_plan: 'sp',
  construction_progress: 'p',
  cashflow: 'cf',
  dim_date: 'd',
};

const PG = Dialect.PostgreSQL;
const fragCache = new Map(); // фрагмент -> переписанный с алиасами (процесс живёт долго, кэш ок)

/** SQL-фрагмент с именами таблиц -> тот же фрагмент с алиасами. */
function rewriteFragment(sql) {
  if (fragCache.has(sql)) return fragCache.get(sql);
  const r = parse(`SELECT ${sql}`, PG);
  if (!r.success) throw new Error(`фрагмент не парсится: "${sql}" (${r.error})`);
  const renamed = ast.renameTables(r.ast[0], ALIASES);
  const g = generate([renamed], PG);
  if (!g.success || !g.sql?.[0]) throw new Error(`фрагмент не компилируется: "${sql}" (${g.error})`);
  const out = g.sql[0].replace(/^SELECT\s+/i, '');
  fragCache.set(sql, out);
  return out;
}

/** "sales.unit_id" -> "s.unit_id" */
function qualifyRef(tableCol) {
  const [t, c] = String(tableCol).split('.');
  return `${ALIASES[t] ?? t}.${c}`;
}

// ---------- разрешение сущностей ----------

function resolveRef(model, ref) {
  const dim = model.dimensions?.find((d) => d.name === ref);
  if (dim) {
    const table = model.physical.table;
    return {
      kind: 'dimension',
      name: ref,
      expr: rewriteFragment(dim.sql ?? `${table}.${ref}`),
      requiresJoin: dim.requires_join ?? [],
      type: dim.type ?? 'string',
      domain: dim.domain,
    };
  }
  const me = (model.measures ?? []).find((m) => m.name === ref);
  if (me) {
    const formula = me.type === 'ratio' ? `(${me.numerator_sql}) / (${me.denominator_sql})` : me.sql;
    // order_by вида "table.col DESC": переписываем идентификатор отдельно,
    // иначе парсер прочтёт DESC как алиас колонки
    const orderM = me.order_by ? String(me.order_by).match(/^(.+?)\s+(ASC|DESC)$/i) : null;
    return {
      kind: 'measure',
      name: ref,
      expr: rewriteFragment(formula),
      requiresJoin: me.requires_join ?? [],
      measureType: me.type ?? 'simple',
      snapshotKey: me.snapshot_key ? rewriteFragment(me.snapshot_key) : null,
      snapshotOrder: me.order_by
        ? `${rewriteFragment(orderM ? orderM[1] : me.order_by)} ${(orderM?.[2] ?? 'DESC').toUpperCase()}`
        : null,
    };
  }
  const names = [
    ...(model.dimensions ?? []).map((d) => d.name),
    ...(model.measures ?? []).map((m) => m.name),
  ];
  throw new Error(`в модели "${model.name}" нет измерения или меры "${ref}" (доступны: ${names.join(', ') || '—'})`);
}

// ---------- литералы ----------

function renderLiteral(value, type) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('числовой литерал должен быть конечным числом');
    return String(value);
  }
  if (typeof value !== 'string') throw new Error(`неподдержанный литерал: ${JSON.stringify(value)}`);
  if (type === 'date') {
    const d = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
      throw new Error(`значение "${value}" не похоже на дату в формате YYYY-MM-DD`);
    }
    return `DATE '${value}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function checkValueType(value, type, ref) {
  const expectNum = type === 'integer' || type === 'decimal' || type === 'number';
  if (expectNum && typeof value !== 'number') {
    throw new Error(`"${ref}": ожидается число (тип измерения ${type}), получено ${JSON.stringify(value)}`);
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`"${ref}": ожидается boolean, получено ${JSON.stringify(value)}`);
  }
  if ((type === 'string' || type === 'date') && typeof value !== 'string') {
    throw new Error(`"${ref}": ожидается строка, получено ${JSON.stringify(value)}`);
  }
}

function checkDomain(value, entity) {
  if (!entity.domain) return;
  if (!entity.domain.map((d) => String(d)).includes(String(value))) {
    throw new Error(
      `значение ${JSON.stringify(value)} вне домена измерения "${entity.name}" ` +
      `(${entity.domain.map((d) => JSON.stringify(d)).join(', ')})`,
    );
  }
}

function renderCondition(f, resolved) {
  const entity = resolved.get(f.ref);
  if (!entity) throw new Error(`фильтр ссылается на неизвестный ref "${f.ref}"`);
  const nullary = f.op === 'is_null' || f.op === 'is_not_null';
  if (!nullary && f.value === undefined) {
    throw new Error(`фильтр "${f.ref}" ${f.op}: не задано value`);
  }
  if (nullary) return `${entity.expr} IS ${f.op === 'is_null' ? 'NULL' : 'NOT NULL'}`;

  if (entity.kind === 'measure') {
    if (f.op === 'in') throw new Error(`фильтр по мере "${f.ref}": op "in" не поддерживается для мер`);
    if (typeof f.value !== 'number') {
      throw new Error(`фильтр по мере "${f.ref}": value должен быть числом, получено ${JSON.stringify(f.value)}`);
    }
    return `${entity.expr} ${f.op} ${renderLiteral(f.value)}`;
  }

  // измерение
  if (f.op === 'in') {
    if (!Array.isArray(f.value) || !f.value.length) {
      throw new Error(`фильтр "${f.ref}" in: value должен быть непустым массивом`);
    }
    for (const v of f.value) {
      checkValueType(v, entity.type, f.ref);
      checkDomain(v, entity);
    }
    const list = f.value.map((v) => renderLiteral(v, entity.type)).join(', ');
    return `${entity.expr} IN (${list})`;
  }
  checkValueType(f.value, entity.type, f.ref);
  checkDomain(f.value, entity);
  return `${entity.expr} ${f.op} ${renderLiteral(f.value, entity.type)}`;
}

// ---------- джойны: BFS по реестру связей ----------

function buildAdjacency(relationships) {
  const adj = new Map(); // table -> [{table, from, to}]
  const addEdge = (a, b, from, to) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ table: b, from, to });
  };
  for (const r of relationships ?? []) {
    const [ft] = String(r.from).split('.');
    const [tt] = String(r.to).split('.');
    if (r.role === 'calendar') continue; // календарные рёбра — не путь обхода
    addEdge(ft, tt, r.from, r.to);
    addEdge(tt, ft, r.from, r.to); // равенство симметрично
  }
  for (const list of adj.values()) list.sort((a, b) => a.table.localeCompare(b.table));
  return adj;
}

/**
 * Дерево джойнов: кратчайшие пути от факта к каждой требуемой таблице,
 * развёрнутые в список рёбер. Промежуточные таблицы пути включаются
 * автоматически; побочные ветви обхода — нет. Детерминировано
 * (адъяцентность отсортирована, цели разбираются в отсортированном порядке).
 */
function resolveJoins(fact, required, relationships) {
  const adj = buildAdjacency(relationships);
  const targets = [...required].filter((t) => t !== fact).sort();
  if (!targets.length) return [];

  // BFS от факта по всему графу: дерево предков
  const prev = new Map(); // table -> {parent, from, to}
  const visited = new Set([fact]);
  let frontier = [fact];
  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur) ?? []) {
        if (visited.has(e.table)) continue;
        visited.add(e.table);
        prev.set(e.table, { parent: cur, from: e.from, to: e.to });
        next.push(e.table);
      }
    }
    frontier = next;
  }

  const unreachable = targets.filter((t) => !prev.has(t) && t !== fact);
  if (unreachable.length) {
    throw new Error(
      `таблица ${unreachable.map((t) => `"${t}"`).join(', ')} недостижима из "${fact}" по реестру связей — план нельзя скомпилировать`,
    );
  }

  // разворачиваем пути fact -> target, дедуплицируем рёбра
  const joins = [];
  const seen = new Set();
  for (const t of targets) {
    const path = [];
    let cur = t;
    while (cur !== fact) {
      const p = prev.get(cur);
      path.unshift({ table: cur, from: p.from, to: p.to });
      cur = p.parent;
    }
    for (const j of path) {
      const [ft] = j.from.split('.');
      const [tt] = j.to.split('.');
      const key = ft < tt ? `${ft}|${tt}` : `${tt}|${ft}`;
      if (!seen.has(key)) {
        seen.add(key);
        joins.push(j);
      }
    }
  }
  return joins;
}

// ---------- сборка ----------

/**
 * plan — валидированный parsePlan-ом объект.
 * semantic — { models, relationships } из семантического загрузчика.
 * Возвращает детерминированный SQL (PostgreSQL). Бросает Error с причиной отказа.
 */
export function compilePlan(plan, semantic) {
  const models = semantic?.models ?? [];
  const model = models.find((m) => m.name === plan.from);
  if (!model) {
    throw new Error(`неизвестная модель "${plan.from}" (доступны: ${models.map((m) => m.name).join(', ') || '—'})`);
  }
  const fact = model.physical.table;

  // select
  const seenAliases = new Set();
  const items = plan.select.map((s) => {
    if (seenAliases.has(s.alias)) throw new Error(`дублирующийся алиас колонки "${s.alias}"`);
    seenAliases.add(s.alias);
    const entity = resolveRef(model, s.ref);
    if ((s.scale !== undefined || s.round !== undefined) && entity.kind !== 'measure') {
      throw new Error(`scale/round допустимы только для мер (select "${s.ref}")`);
    }
    return { ...s, entity };
  });

  // where/having
  const resolved = new Map();
  const wheres = [];
  const havings = [];
  for (const f of plan.where ?? []) {
    if (!resolved.has(f.ref)) resolved.set(f.ref, resolveRef(model, f.ref));
    const cond = renderCondition(f, resolved);
    (resolved.get(f.ref).kind === 'measure' ? havings : wheres).push(cond);
  }

  // group_by
  const dimItems = items.filter((i) => i.entity.kind === 'dimension');
  const measureItems = items.filter((i) => i.entity.kind === 'measure');

  // latest_snapshot: DISTINCT ON, без группировки и HAVING
  const snapshotItems = measureItems.filter((i) => i.entity.measureType === 'latest_snapshot');
  if (snapshotItems.length) {
    if (snapshotItems.length !== measureItems.length) {
      throw new Error('latest_snapshot-меры нельзя смешивать с агрегирующими мерами в одном запросе');
    }
    if (plan.group_by?.length || havings.length) {
      throw new Error('latest_snapshot-меры не работают с group_by и фильтрами по мерам');
    }
  }
  const snapshotExpr = snapshotItems[0]?.entity.snapshotKey ?? null;

  let groupExprs = [];
  if (plan.group_by?.length) {
    groupExprs = plan.group_by.map((ref) => {
      const item = dimItems.find((i) => i.ref === ref);
      if (!item) throw new Error(`group_by "${ref}": нет такого измерения в select (группировать можно только по измерениям из select)`);
      return item.entity.expr;
    });
  } else if (measureItems.length && dimItems.length && !snapshotItems.length) {
    groupExprs = dimItems.map((i) => i.entity.expr); // авто-группировка по всем измерениям select
  }

  // order_by — только по алиасам select
  const orderExprs = (plan.order_by ?? []).map((o) => {
    if (!seenAliases.has(o.alias)) throw new Error(`order_by "${o.alias}": нет колонки с таким алиасом в select`);
    return `${o.alias} ${(o.dir ?? 'asc').toUpperCase()}`;
  });

  // джойны
  const required = new Set([fact]);
  for (const i of items) for (const t of i.entity.requiresJoin) required.add(t);
  for (const e of resolved.values()) for (const t of e.requiresJoin) required.add(t);
  const joins = resolveJoins(fact, required, semantic.relationships);

  // ---- текст ----
  const selectList = items.map((i) => {
    let expr = i.entity.expr;
    if (i.entity.kind === 'measure') {
      if (i.scale !== undefined && i.round !== undefined) expr = `ROUND((${expr}) / ${i.scale}, ${i.round})`;
      else if (i.scale !== undefined) expr = `(${expr}) / ${i.scale}`;
      else if (i.round !== undefined) expr = `ROUND(${expr}, ${i.round})`;
    }
    return `${expr} AS ${i.alias}`;
  });

  const distinctOn = snapshotExpr ? `DISTINCT ON (${snapshotExpr}) ` : '';
  const parts = [`SELECT ${distinctOn}${selectList.join(', ')}`, `FROM ${fact} AS ${ALIASES[fact]}`];
  for (const j of joins) {
    parts.push(`JOIN ${j.table} AS ${ALIASES[j.table]} ON ${qualifyRef(j.from)} = ${qualifyRef(j.to)}`);
  }
  if (wheres.length) parts.push(`WHERE ${wheres.join(' AND ')}`);
  if (groupExprs.length) parts.push(`GROUP BY ${groupExprs.join(', ')}`);
  if (havings.length) parts.push(`HAVING ${havings.join(' AND ')}`);

  const orderParts = [];
  if (snapshotExpr) {
    orderParts.push(`${snapshotExpr} ASC`, snapshotItems[0].entity.snapshotOrder ?? `${snapshotExpr} DESC`);
  }
  orderParts.push(...orderExprs);
  if (orderParts.length) parts.push(`ORDER BY ${orderParts.join(', ')}`);
  if (plan.limit !== undefined) parts.push(`LIMIT ${plan.limit}`);

  // ---- AST-проверка и канонический рендер ----
  const text = parts.join(' ');
  const parsed = parse(text, PG);
  if (!parsed.success) {
    throw new Error(`скомпилированный SQL не прошёл синтаксическую проверку: ${parsed.error}`);
  }
  const gen = generate(parsed.ast, PG);
  if (!gen.success || !gen.sql?.[0]) {
    throw new Error(`не удалось отрендерить SQL: ${gen.error ?? 'unknown'}`);
  }
  return gen.sql[0];
}
