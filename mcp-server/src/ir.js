// IR (промежуточное представление) запроса: строгая схема плана, который
// генерирует LLM, и его синтаксическая валидация. Семантическая проверка
// (существование мер/измерений, связность джойнов) — в compiler.js.
//
// План — единственное, что модель produceирует свободно; всё остальное
// (SQL) строится детерминированно компилятором.

import { z } from 'zod';

const NAME_RE = /^[a-z][a-z0-9_]*$/;

const filterSchema = z.object({
  ref: z.string().min(1),
  op: z.enum(['=', '!=', '>', '>=', '<', '<=', 'in', 'is_null', 'is_not_null']),
  value: z.unknown().optional(),
});

const planSchema = z
  .object({
    from: z.string().min(1),
    select: z
      .array(
        z.object({
          ref: z.string().min(1),
          alias: z.string().regex(NAME_RE, 'alias: только латиница в snake_case'),
          scale: z.number().positive().optional(), // делитель для вывода (1e6 -> млн)
          round: z.number().int().min(0).max(10).optional(),
        }),
      )
      .min(1)
      .max(20),
    where: z.array(filterSchema).max(30).optional(),
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

/**
 * Разбирает и валидирует план из ответа модели.
 * Бросает Error с человекочитаемым списком проблем.
 */
export function parsePlan(raw) {
  const r = planSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map(formatIssue);
    throw new Error(`План некорректен:\n- ${issues.join('\n- ')}`);
  }
  return r.data;
}
