// Детерминированный компилятор: IR (план) -> SQL (PostgreSQL) через polyglot.
//
// Гарантии:
// - SQL строится только из сущностей семантического слоя (меры/измерения/связи)
//   и структуры плана; неизвестное — честный отказ, свободный SQL недопустим.
// - Детерминизм: один план -> один и тот же SQL. Алиасы таблиц фиксированы,
//   джойны — кратчайшие пути по графу relationships.yaml (BFS с отсортированной
//   адъяцентностью), порядок конструкций — порядок плана.
// - Фрагменты YAML квалифицированы именами таблиц; в SQL они подставляются
//   AST-проходом polyglot (renameTables), голые колонки не неоднозначны.
// - Вывод проходит parse + generate (PostgreSQL-диалект): сбой синтаксиса —
//   исключение, некорректный SQL наружу не уходит.
//
// Два вида планов (ir.js): v1 — одна модель-факт; v2 — подпланы (with) -> CTE,
// внешний запрос соединяет их (join) и оперирует колонками CTE и expr.

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

/** AST-проверка и канонический рендер. Бросает Error при синтаксической ошибке. */
function finalize(text) {
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

// ---------- выражения (IR v2) ----------

function isExpr(v) {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    ('ref' in v || 'cte' in v || 'op' in v || 'fn' in v)
  );
}

/**
 * Рендер expr: число | {ref} (модель) | {cte,col} | {op,a,b} | {fn:coalesce}.
 * ctx: {model} — внутри подплана; {cteCols} — во внешнем запросе;
 * {model, refAlias} — фильтры поверх latest_snapshot: ref подставляется алиасом колонки.
 */
function renderExpr(e, ctx) {
  if (typeof e === 'number') {
    if (!Number.isFinite(e)) throw new Error('числовой литерал должен быть конечным числом');
    return String(e);
  }
  if (typeof e !== 'object' || e === null) throw new Error(`невалидное выражение: ${JSON.stringify(e)}`);
  if ('ref' in e) {
    if (ctx.refAlias?.has(e.ref)) return ctx.refAlias.get(e.ref);
    if (!ctx.model) throw new Error(`"{ref: ${e.ref}}" недопустим вне подплана`);
    return resolveRef(ctx.model, e.ref).expr;
  }
  if ('cte' in e) {
    if (!ctx.cteCols) throw new Error(`"{cte: ${e.cte}}" допустим только во внешнем запросе с подпланами`);
    if (!ctx.cteCols.has(e.cte)) throw new Error(`неизвестный подплан "${e.cte}" (доступны: ${[...ctx.cteCols.keys()].join(', ')})`);
    if (!ctx.cteCols.get(e.cte).has(e.col)) {
      throw new Error(`в подплане "${e.cte}" нет колонки "${e.col}" (доступны: ${[...ctx.cteCols.get(e.cte)].join(', ')})`);
    }
    return `${e.cte}.${e.col}`;
  }
  if ('op' in e) {
    const a = renderExpr(e.a, ctx);
    const b = renderExpr(e.b, ctx);
    return `(${a}) ${e.op} (${b})`;
  }
  if ('fn' in e) {
    if (e.fn !== 'coalesce') throw new Error(`неподдержанная функция "${e.fn}" (доступны: coalesce)`);
    return `COALESCE(${e.args.map((a) => renderExpr(a, ctx)).join(', ')})`;
  }
  throw new Error(`невалидное выражение: ${JSON.stringify(e)}`);
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

/** Фильтр в контексте модели: value — литерал | {"ref": ...} | expr над ref. */
function renderModelCondition(f, model, resolved) {
  if (!resolved.has(f.ref)) resolved.set(f.ref, resolveRef(model, f.ref));
  const entity = resolved.get(f.ref);
  const nullary = f.op === 'is_null' || f.op === 'is_not_null';
  if (!nullary && f.value === undefined) {
    throw new Error(`фильтр "${f.ref}" ${f.op}: не задано value`);
  }
  if (nullary) return `${entity.expr} IS ${f.op === 'is_null' ? 'NULL' : 'NOT NULL'}`;

  if (isExpr(f.value)) {
    if (f.op === 'in') throw new Error(`фильтр "${f.ref}" in: value-выражения не поддерживаются для in`);
    return `${entity.expr} ${f.op} ${renderExpr(f.value, { model })}`;
  }

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
 * Список джойнов: кратчайшие пути от факта к каждой требуемой таблице,
 * развёрнутые в рёбра; промежуточные таблицы пути включаются автоматически,
 * побочные ветви обхода — нет. Детерминировано.
 */
function resolveJoins(fact, required, relationships) {
  const adj = buildAdjacency(relationships);
  const targets = [...required].filter((t) => t !== fact).sort();
  if (!targets.length) return [];

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

// ---------- сборка модельного запроса (v1 и тело подплана) ----------

function findModel(semantic, name) {
  const models = semantic?.models ?? [];
  const model = models.find((m) => m.name === name);
  if (!model) {
    throw new Error(`неизвестная модель "${name}" (доступны: ${models.map((m) => m.name).join(', ') || '—'})`);
  }
  return model;
}

function wrapMeasure(expr, scale, round) {
  if (scale !== undefined && round !== undefined) return `ROUND((${expr}) / ${scale}, ${round})`;
  if (scale !== undefined) return `(${expr}) / ${scale}`;
  if (round !== undefined) return `ROUND(${expr}, ${round})`;
  return expr;
}

/**
 * Собирает SELECT над одной моделью (v1-запрос целиком либо тело подплана).
 * Возвращает {text, aliases} — текст без финального AST-прохода и множество
 * алиасов колонок. orderExprs/limit — только для v1.
 */
function assembleModelQuery({ model, selectItems, where, groupBy, orderExprs = [], limit }, semantic, { allowSnapshot }) {
  const fact = model.physical.table;
  const seenAliases = new Set();
  const aliases = new Set();

  const items = selectItems.map((s) => {
    if (seenAliases.has(s.alias)) throw new Error(`дублирующийся алиас колонки "${s.alias}"`);
    seenAliases.add(s.alias);
    aliases.add(s.alias);
    let entity;
    if (s.cte || s.col) {
      throw new Error(`select "${s.alias}": cte+col допустимы только во внешнем запросе с подпланами (with)`);
    }
    if (s.expr !== undefined) {
      entity = { kind: 'expr', name: s.alias, expr: renderExpr(s.expr, { model }), requiresJoin: [] };
    } else {
      entity = resolveRef(model, s.ref);
      if ((s.scale !== undefined || s.round !== undefined) && entity.kind === 'dimension') {
        throw new Error(`scale/round допустимы только для мер и выражений (select "${s.ref}")`);
      }
    }
    return { ...s, entity };
  });

  const resolved = new Map();
  const whereList = []; // [{f, entity}] — рендер позже: обычный или поверх среза
  const havingList = [];
  for (const f of where ?? []) {
    if (!resolved.has(f.ref)) resolved.set(f.ref, resolveRef(model, f.ref));
    const entity = resolved.get(f.ref);
    // фильтр по агрегирующей мере — HAVING; по измерению и latest_snapshot — WHERE
    const toHaving = entity.kind === 'measure' && entity.measureType !== 'latest_snapshot';
    (toHaving ? havingList : whereList).push({ f, entity });
  }
  const havings = havingList.map(({ f }) => renderModelCondition(f, model, resolved));

  const dimItems = items.filter((i) => i.entity.kind === 'dimension');
  const measureItems = items.filter((i) => i.entity.kind === 'measure');
  const exprItems = items.filter((i) => i.entity.kind === 'expr');

  const snapshotItems = measureItems.filter((i) => i.entity.measureType === 'latest_snapshot');
  if (snapshotItems.length && !allowSnapshot) {
    throw new Error('latest_snapshot-меры в подпланах не поддержаны — вынеси их в основной запрос');
  }
  if (snapshotItems.length) {
    if (snapshotItems.length !== measureItems.length) {
      throw new Error('latest_snapshot-меры нельзя смешивать с агрегирующими мерами в одном запросе');
    }
    if (groupBy?.length || havings.length) {
      throw new Error('latest_snapshot-меры не работают с group_by и фильтрами по мерам');
    }
  }
  const snapshotExpr = snapshotItems[0]?.entity.snapshotKey ?? null;

  let groupExprs = [];
  if (groupBy?.length) {
    groupExprs = groupBy.map((ref) => {
      const item = items.find((i) => i.ref === ref);
      if (!item) throw new Error(`group_by "${ref}": нет такого ref в select (группировать можно только по элементам select с ref)`);
      if (item.entity.kind !== 'dimension') throw new Error(`group_by "${ref}": группировка только по измерениям`);
      return item.entity.expr;
    });
  } else if (measureItems.length && dimItems.length && !snapshotItems.length) {
    groupExprs = dimItems.map((i) => i.entity.expr); // авто-группировка по всем измерениям select
  }

  // latest_snapshot + WHERE: фильтр должен применяться К ВЫБРАННОМУ срезу,
  // а не выбирать последний месяц среди подходящих — оборачиваем в подзапрос
  let wheres = [];
  let aliasWrap = null;
  if (snapshotExpr && whereList.length) {
    const refAlias = new Map(items.filter((i) => i.ref).map((i) => [i.ref, i.alias]));
    aliasWrap = whereList.map(({ f, entity }) => renderAliasedCondition(f, entity, model, refAlias));
  } else {
    wheres = whereList.map(({ f }) => renderModelCondition(f, model, resolved));
  }

  // джойны
  const required = new Set([fact]);
  for (const i of items) for (const t of i.entity.requiresJoin) required.add(t);
  for (const e of resolved.values()) for (const t of e.requiresJoin) required.add(t);
  const joins = resolveJoins(fact, required, semantic.relationships);

  const selectList = items.map((i) => {
    let expr = i.entity.expr;
    if (i.entity.kind !== 'dimension') expr = wrapMeasure(expr, i.scale, i.round);
    return `${expr} AS ${i.alias}`;
  });

  const parts = [`SELECT ${snapshotExpr ? `DISTINCT ON (${snapshotExpr}) ` : ''}${selectList.join(', ')}`, `FROM ${fact} AS ${ALIASES[fact]}`];
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
  if (limit !== undefined) parts.push(`LIMIT ${limit}`);

  const text = parts.join(' ');
  return {
    text: aliasWrap ? `SELECT * FROM (${text}) AS _snap WHERE ${aliasWrap.join(' AND ')}` : text,
    aliases,
  };
}

/** Условие поверх среза latest_snapshot: колонки подставляются алиасами select. */
function renderAliasedCondition(f, entity, model, refAlias) {
  const left = refAlias.get(f.ref);
  if (!left) {
    throw new Error(
      `фильтр по "${f.ref}": в запросе с latest_snapshot фильтр применяется к выбранному срезу — ` +
      `выведи "${f.ref}" в select, чтобы можно было отфильтровать`,
    );
  }
  const nullary = f.op === 'is_null' || f.op === 'is_not_null';
  if (!nullary && f.value === undefined) {
    throw new Error(`фильтр "${f.ref}" ${f.op}: не задано value`);
  }
  if (nullary) return `${left} IS ${f.op === 'is_null' ? 'NULL' : 'NOT NULL'}`;
  if (isExpr(f.value)) {
    if (f.op === 'in') throw new Error(`фильтр "${f.ref}" in: value-выражения не поддерживаются для in`);
    return `${left} ${f.op} ${renderExpr(f.value, { model, refAlias })}`;
  }
  if (entity.kind === 'measure' || entity.kind === 'expr') {
    if (typeof f.value !== 'number') {
      throw new Error(`фильтр по "${f.ref}": value должен быть числом, получено ${JSON.stringify(f.value)}`);
    }
    return `${left} ${f.op} ${renderLiteral(f.value)}`;
  }
  if (f.op === 'in') {
    if (!Array.isArray(f.value) || !f.value.length) throw new Error(`фильтр "${f.ref}" in: value должен быть непустым массивом`);
    for (const v of f.value) {
      checkValueType(v, entity.type, f.ref);
      checkDomain(v, entity);
    }
    return `${left} IN (${f.value.map((v) => renderLiteral(v, entity.type)).join(', ')})`;
  }
  checkValueType(f.value, entity.type, f.ref);
  checkDomain(f.value, entity);
  return `${left} ${f.op} ${renderLiteral(f.value, entity.type)}`;
}

// ---------- точка входа ----------

/**
 * plan — валидированный parsePlan-ом объект.
 * semantic — { models, relationships } из семантического загрузчика.
 * Возвращает детерминированный SQL (PostgreSQL). Бросает Error с причиной отказа.
 */
export function compilePlan(plan, semantic) {
  if (plan.with?.length) return compileWithPlan(plan, semantic);
  const model = findModel(semantic, plan.from);

  const orderExprs = (plan.order_by ?? []).map((o) => {
    if (!plan.select.some((s) => s.alias === o.alias)) throw new Error(`order_by "${o.alias}": нет колонки с таким алиасом в select`);
    return `${o.alias} ${(o.dir ?? 'asc').toUpperCase()}`;
  });

  const { text } = assembleModelQuery(
    { model, selectItems: plan.select, where: plan.where, groupBy: plan.group_by, orderExprs, limit: plan.limit },
    semantic,
    { allowSnapshot: true },
  );
  return finalize(text);
}

// ---------- IR v2: подпланы -> CTE, внешний запрос ----------

function compileWithPlan(plan, semantic) {
  // подпланы
  const cteCols = new Map(); // name -> Set<alias>
  const inners = [];
  for (const sp of plan.with) {
    if (cteCols.has(sp.name)) throw new Error(`дублирующееся имя подплана "${sp.name}"`);
    const model = findModel(semantic, sp.from);
    const { text, aliases } = assembleModelQuery(
      { model, selectItems: sp.select, where: sp.where, groupBy: sp.group_by },
      semantic,
      { allowSnapshot: false },
    );
    cteCols.set(sp.name, aliases);
    inners.push(`${sp.name} AS (${text})`);
  }

  // соединение
  const join = plan.join ?? [];
  if (join.length < 2) throw new Error('join: нужно минимум два подплана для соединения');
  if (!cteCols.has(join[0].cte)) throw new Error(`join: неизвестный подплан "${join[0].cte}"`);
  if (join[0].type || join[0].on) throw new Error('join: первая запись — это FROM, у неё не должно быть type/on');
  const introduced = new Set([join[0].cte]);
  const joinSqls = [];
  const JOIN_TYPE = { left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL OUTER JOIN', inner: 'JOIN' };
  for (const j of join.slice(1)) {
    if (!cteCols.has(j.cte)) throw new Error(`join: неизвестный подплан "${j.cte}" (доступны: ${[...cteCols.keys()].join(', ')})`);
    const type = j.type ?? 'inner';
    if (type === 'cross') {
      if (j.on?.length) throw new Error(`join ${j.cte}: CROSS JOIN не принимает on`);
      joinSqls.push(`CROSS JOIN ${j.cte}`);
    } else {
      if (!j.on?.length) throw new Error(`join ${j.cte}: нужен on — пары колонок [левая, правая]`);
      const conds = j.on.map(([a, b]) => {
        const curHas = (c) => cteCols.get(j.cte).has(c);
        // владелец левой колонки: ПЕРВЫЙ введённый подплан, где она есть
        // (якорная семантика: план/факт цепляются к базовому справочнику,
        // а не друг к другу; детерминировано — порядок introduced фиксирован)
        const ownerOf = (c) => {
          for (const name of introduced) {
            if (cteCols.get(name).has(c)) return name;
          }
          return null;
        };
        const ownerA = ownerOf(a);
        const ownerB = ownerOf(b);
        if (ownerA && curHas(b)) return `${ownerA}.${a} = ${j.cte}.${b}`;
        if (ownerB && curHas(a)) return `${ownerB}.${b} = ${j.cte}.${a}`;
        throw new Error(
          `join ${j.cte}: пара [${a}, ${b}] не разрешается — проверь имена колонок ` +
          `(уже введены: ${[...introduced].map((n) => `${n}(${[...cteCols.get(n)].join(',')})`).join(' ')}; в ${j.cte}: ${[...cteCols.get(j.cte)].join(',')})`,
        );
      });
      joinSqls.push(`${JOIN_TYPE[type]} ${j.cte} ON ${conds.join(' AND ')}`);
    }
    introduced.add(j.cte);
  }

  // внешний select
  const seenAliases = new Set();
  const selectList = plan.select.map((s) => {
    if (seenAliases.has(s.alias)) throw new Error(`дублирующийся алиас колонки "${s.alias}"`);
    seenAliases.add(s.alias);
    let expr;
    if (s.expr !== undefined) {
      expr = renderExpr(s.expr, { cteCols });
    } else if (s.cte && s.col) {
      if (!cteCols.has(s.cte)) throw new Error(`select "${s.alias}": неизвестный подплан "${s.cte}"`);
      if (!cteCols.get(s.cte).has(s.col)) throw new Error(`select "${s.alias}": в подплане "${s.cte}" нет колонки "${s.col}"`);
      expr = `${s.cte}.${s.col}`;
    } else {
      throw new Error(`select "${s.alias}": нужен либо expr, либо cte+col`);
    }
    return `${wrapMeasure(expr, s.scale, s.round)} AS ${s.alias}`;
  });

  // внешний where: ref вида "cte.col"
  const wheres = (plan.where ?? []).map((f) => {
    const [cte, col, ...rest] = String(f.ref).split('.');
    if (rest.length || !cte || !col) throw new Error(`фильтр "${f.ref}": во внешнем запросе ref задаётся как "подплан.колонка"`);
    if (!cteCols.has(cte)) throw new Error(`фильтр "${f.ref}": неизвестный подплан "${cte}"`);
    if (!cteCols.get(cte).has(col)) throw new Error(`фильтр "${f.ref}": в подплане "${cte}" нет колонки "${col}"`);
    const left = `${cte}.${col}`;
    const nullary = f.op === 'is_null' || f.op === 'is_not_null';
    if (nullary) return `${left} IS ${f.op === 'is_null' ? 'NULL' : 'NOT NULL'}`;
    if (f.value === undefined) throw new Error(`фильтр "${f.ref}" ${f.op}: не задано value`);
    if (isExpr(f.value)) return `${left} ${f.op} ${renderExpr(f.value, { cteCols })}`;
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length) throw new Error(`фильтр "${f.ref}" in: value должен быть непустым массивом`);
      return `${left} IN (${f.value.map((v) => renderLiteral(v)).join(', ')})`;
    }
    return `${left} ${f.op} ${renderLiteral(f.value)}`;
  });

  if (plan.group_by?.length) {
    throw new Error('group_by во внешнем запросе с подпланами не поддержан — группируй внутри подпланов');
  }

  const orderExprs = (plan.order_by ?? []).map((o) => {
    if (!seenAliases.has(o.alias)) throw new Error(`order_by "${o.alias}": нет колонки с таким алиасом в select`);
    return `${o.alias} ${(o.dir ?? 'asc').toUpperCase()}`;
  });

  const parts = [`SELECT ${selectList.join(', ')}`, `FROM ${join[0].cte}`];
  parts.push(...joinSqls);
  if (wheres.length) parts.push(`WHERE ${wheres.join(' AND ')}`);
  if (orderExprs.length) parts.push(`ORDER BY ${orderExprs.join(', ')}`);
  if (plan.limit !== undefined) parts.push(`LIMIT ${plan.limit}`);

  return finalize(`WITH ${inners.join(', ')} ${parts.join(' ')}`);
}
