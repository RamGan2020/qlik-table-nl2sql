// IR (промежуточное представление) запроса: строгая схема плана, который
// генерирует LLM, и его синтаксическая валидация. Семантическая проверка
// (существование мер/измерений/CTE, связность джойнов) — в compiler.js.
//
// Два вида планов:
//  - v1: одна модель-факт (from) — агрегации, фильтры, группировка;
//  - v2: подпланы (with) -> CTE, внешний запрос соединяет их (join),
//    select/where оперируют колонками CTE и выражениями (expr).
// Модель produceирует только план; SQL строится детерминированно компилятором.

import { z } from 'zod';

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_EXPR_DEPTH = 10;

const filterSchema = z.object({
  ref: z.string().min(1),
  op: z.enum(['=', '!=', '>', '>=', '<', '<=', 'in', 'is_null', 'is_not_null']),
  value: z.unknown().optional(), // литерал | {"ref": ...} | expr — разбор в compiler.js
});

// Арифметическое выражение: число | колонка CTE | ref модели | op | fn.
const exprSchema = z.lazy(() =>
  z.union([
    z.number(),
    z.object({ ref: z.string().min(1) }),
    z.object({ cte: z.string().min(1), col: z.string().min(1) }),
    z.object({ op: z.enum(['+', '-', '*', '/']), a: exprSchema, b: exprSchema }),
    z.object({ fn: z.enum(['coalesce']), args: z.array(exprSchema).min(2).max(4) }),
  ]),
);

const v1Item = z.object({
  ref: z.string().min(1),
  alias: z.string().regex(NAME_RE, 'alias: только латиница в snake_case'),
  scale: z.number().positive().optional(),
  round: z.number().int().min(0).max(10).optional(),
});

const v2Item = z.object({
  cte: z.string().min(1).optional(),
  col: z.string().min(1).optional(),
  expr: exprSchema.optional(),
  alias: z.string().regex(NAME_RE, 'alias: только латиница в snake_case'),
  scale: z.number().positive().optional(),
  round: z.number().int().min(0).max(10).optional(),
});

const subplanSchema = z
  .object({
    name: z.string().regex(NAME_RE, 'имя подплана: латиница в snake_case'),
    from: z.string().min(1),
    select: z.array(z.union([v1Item, v2Item])).min(1).max(20),
    where: z.array(filterSchema).max(30).optional(),
    group_by: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict();

const joinSchema = z
  .object({
    cte: z.string().min(1),
    type: z.enum(['left', 'right', 'full', 'inner', 'cross']).optional(), // по умолчанию inner
    on: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1).max(3).optional(),
  })
  .strict();

const planSchema = z
  .object({
    with: z.array(subplanSchema).min(1).max(5).optional(),
    join: z.array(joinSchema).min(2).max(5).optional(),
    from: z.string().min(1).optional(), // v1: модель-факт (взаимоисключает with/join)
    select: z.array(z.union([v1Item, v2Item])).min(1).max(20),
    where: z.array(filterSchema).max(30).optional(), // v1: ref модели; v2: ref вида "cte.col"
    group_by: z.array(z.string().min(1)).max(10).optional(),
    order_by: z
      .array(z.object({ alias: z.string().min(1), dir: z.enum(['asc', 'desc']).optional() }))
      .max(10)
      .optional(),
    limit: z.number().int().min(1).max(10000).optional(),
    note: z.string().max(500).optional(),
  })
  .strict(); // неизвестные ключи — честный отказ, а не молчаливый игнор

function formatIssue(e) {
  const path = e.path?.length ? e.path.join('.') : '(корень)';
  return `${path}: ${e.message}`;
}

function exprDepth(e, d = 0) {
  if (d > MAX_EXPR_DEPTH) return d;
  if (typeof e !== 'object' || e === null) return d;
  if ('op' in e) return Math.max(exprDepth(e.a, d + 1), exprDepth(e.b, d + 1));
  if ('fn' in e) return Math.max(...e.args.map((a) => exprDepth(a, d + 1)));
  return d;
}

/**
 * Разбирает и валидирует план из ответа модели.
 * Бросает Error с человекочитаемым списком проблем.
 */
export function parsePlan(raw) {
  const r = planSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((e) => {
      // union select-item: покажем конкретные проблемы ближайшего варианта элемента
      if (e.code === 'invalid_union' && e.path[0] === 'select' && typeof e.path[1] === 'number') {
        const val = raw?.select?.[e.path[1]];
        const a = v1Item.safeParse(val);
        const b = v2Item.safeParse(val);
        const best =
          !a.success && (b.success || a.error.issues.length <= b.error.issues.length)
            ? a.error.issues
            : b.error?.issues ?? [];
        return `select[${e.path[1]}]: ${best.map(formatIssue).join('; ')}`;
      }
      return formatIssue(e);
    });
    throw new Error(`План некорректен:\n- ${issues.join('\n- ')}`);
  }
  const plan = r.data;
  if (plan.with && !plan.join) {
    throw new Error('План некорректен: подпланы (with) требуют соединения (join)');
  }
  if (plan.with && plan.from) {
    throw new Error('План некорректен: from нельзя сочетать с with — либо одна модель, либо подпланы');
  }
  if (!plan.with && !plan.from) {
    throw new Error('План некорректен: нужен from (модель) или with+join (подпланы)');
  }
  const checkDepth = (e, where) => {
    if (exprDepth(e) > MAX_EXPR_DEPTH) throw new Error(`План некорректен: выражение слишком вложенное (${where})`);
  };
  for (const sp of plan.with ?? []) {
    for (const it of sp.select) if (it.expr !== undefined) checkDepth(it.expr, `with.${sp.name}.${it.alias}`);
  }
  for (const it of plan.select) if (it.expr !== undefined) checkDepth(it.expr, `select.${it.alias}`);
  return plan;
}
