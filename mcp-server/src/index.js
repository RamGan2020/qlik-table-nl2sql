// MCP-сервер: вопрос на естественном языке -> план (IR) -> детерминированный
// SQL (PostgreSQL) через компилятор на polyglot; read-only выполнение.
// Транспорт: stdio. Конфигурация: переменные окружения (см. .env.example).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { normalizeReadOnly } from './guard.js';
import { loadSchemaColumns, loadSchemaText } from './schema.js';
import { createSemanticLoader, renderSemanticBlock } from './semantic.js';
import { callNlToSql } from './llm.js';
import { parsePlan } from './ir.js';
import { compilePlan } from './compiler.js';
import { createCache } from './cache.js';
import { initTrace, traceStep } from './trace.js';
import { createExamplesLoader, renderExamplesBlock } from './examples.js';

// .env грузим ДО любых потребителей окружения: initTrace и createCache ниже
// читают NL2SQL_TRACE/NL2SQL_CACHE уже на этапе инициализации модуля.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });
dotenv.config({ quiet: true }); // fallback: .env из cwd, не переопределяет уже заданные переменные

initTrace();

const cache = createCache(
  process.env.NL2SQL_CACHE && process.env.NL2SQL_CACHE !== '0'
    ? process.env.NL2SQL_CACHE
    : process.env.NL2SQL_CACHE === '0'
      ? ''
      : join(dirname(fileURLToPath(import.meta.url)), '../nl2sql-cache.json'),
);

const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/qlik_table',
  apiKey: process.env.MOONSHOT_API_KEY ?? '',
  baseUrl: (process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1').replace(/\/+$/, ''),
  model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
  temperature: Number(process.env.MOONSHOT_TEMPERATURE ?? 1), // coding-модели допускают только 1; детерминированность даёт кэш (cache.js)
  maxRows: Number.parseInt(process.env.MAX_ROWS ?? '1000', 10),
};

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 3,
  // read-only и таймаут на уровне каждого нового подключения (guard.js — первый слой)
  options: '-c default_transaction_read_only=on -c statement_timeout=15000',
});
pool.on('error', () => {}); // не падать на обрывах соединений

let schemaText = '';
let schemaCols = null; // Map<table, Set<col>> для пост-валидации сгенерированного SQL
async function refreshSchema() {
  schemaText = await loadSchemaText(pool);
  schemaCols = await loadSchemaColumns(pool);
}
await refreshSchema();

// семантическое ядро: автоперечитывание при изменении YAML-моделей (по отпечатку mtime)
const getSemantic = createSemanticLoader(
  join(dirname(fileURLToPath(import.meta.url)), 'models'),
  join(dirname(fileURLToPath(import.meta.url)), 'relationships.yaml'),
);

// few-shot примеры для промпта: вопросы и эталонные SQL из eval/questions.json
const getExamples = createExamplesLoader(
  join(dirname(fileURLToPath(import.meta.url)), '../eval/questions.json'),
);

const server = new McpServer({ name: 'qlik-table-nl2sql', version: '1.0.0' });

const err = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const ok = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

// ---------- Инструмент 1: текст -> SQL ----------

server.registerTool(
  'nl_to_sql',
  {
    title: 'Текст -> SQL',
    description:
      'Принимает вопрос на русском языке и возвращает готовый SQL-запрос (PostgreSQL) ' +
      'по базе финансовой отчётности застройщика. SQL строится детерминированно: ' +
      'модель генерирует план (IR), компилятор превращает его в SQL. ' +
      'Запрос не выполняется — только генерируется.',
    inputSchema: {
      question: z
        .string()
        .describe('Вопрос на естественном языке, например: "Продажи по каналам за 2026 год"'),
    },
  },
  async ({ question }) => {
    if (!config.apiKey) {
      return err('Не задан MOONSHOT_API_KEY. Укажите ключ в переменной окружения или в .env.');
    }
    const t0 = Date.now();
    traceStep('NL_TO_SQL: ВХОД', `question: ${question}\nmodel: ${config.model} · temperature: ${config.temperature}`);
    try {
      const semantic = getSemantic();
      const semanticBlock = renderSemanticBlock(semantic);
      traceStep('СЕМАНТИЧЕСКИЙ БЛОК (подмешивается в системный промпт)', semanticBlock);
      const examplesBlock = process.env.NL2SQL_EXAMPLES === '0' ? '' : renderExamplesBlock(getExamples());
      traceStep('ПРИМЕРЫ few-shot (eval/questions.json)', examplesBlock || '(выключены: NL2SQL_EXAMPLES=0)');
      const cacheKey = cache.key([question, schemaText, semanticBlock, examplesBlock, config.model, config.baseUrl]);

      let fromCache = false;
      let result = cache.get(cacheKey);
      if (result) {
        fromCache = true;
        traceStep('КЭШ: попадание', `ключ: ${cacheKey}\nSQL, план и пояснение взяты из кэша, LLM не вызывался`);
      } else {
        const materialize = (rawPlan, explanation) => {
          const plan = parsePlan(rawPlan);
          const sql = compilePlan(plan, semantic);
          return { sql, plan, explanation };
        };
        // сеть/формат ответа: один чистый повтор вызова до перехода к ошибке
        const callLlm = async (correction = null) => {
          const args = {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            temperature: config.temperature,
            schemaText,
            semanticBlock,
            examplesBlock,
            question,
            correction,
          };
          try {
            return await callNlToSql(args);
          } catch (e1) {
            traceStep('LLM: первый ответ не получен, повтор', e1.message);
            return await callNlToSql(args);
          }
        };
        const raw = await callLlm();
        if (raw.unanswerable) {
          traceStep('ПЛАН: вопрос не поддержан', raw.unanswerable);
          return err(`Вопрос не поддержан плановым интерфейсом: ${raw.unanswerable}`);
        }
        try {
          result = materialize(raw.plan, raw.explanation);
          traceStep('ПЛАН: скомпилирован', JSON.stringify(result.plan, null, 2));
        } catch (e) {
          traceStep('ПЛАН: отклонён валидацией/компилятором', e.message);
          const fixed = await callLlm({ problems: [e.message], previousPlan: raw.plan });
          if (fixed.unanswerable) {
            return err(`Вопрос не поддержан плановым интерфейсом: ${fixed.unanswerable}`);
          }
          try {
            result = materialize(fixed.plan, fixed.explanation);
            traceStep('ПЛАН: исправлен повтором', JSON.stringify(result.plan, null, 2));
          } catch (e2) {
            traceStep('ПЛАН: повтор не помог', e2.message);
            return err(`План не скомпилировался: ${e2.message}`);
          }
        }
      }
      normalizeReadOnly(result.sql); // компилятор порождает SELECT, guard — последний рубеж
      traceStep('GUARD (read-only)', 'ok — одиночный SELECT/WITH, без изменения данных');
      if (!fromCache) {
        cache.set(cacheKey, { sql: result.sql, plan: result.plan, explanation: result.explanation });
        traceStep('КЭШ: сохранено', `ключ: ${cacheKey}\nпоследующие одинаковые вопросы получат этот же SQL без вызова LLM`);
      }
      const payload = { sql: result.sql, plan: result.plan, explanation: result.explanation };
      traceStep('NL_TO_SQL: ИТОГ (возврат из инструмента)', `${JSON.stringify(payload, null, 2)}\n\nвсего ${Date.now() - t0} мс`);
      return ok(payload);
    } catch (e) {
      traceStep('NL_TO_SQL: ОШИБКА', e.message);
      return err(`Ошибка генерации SQL: ${e.message}`);
    }
  },
);

// ---------- Инструмент 2: read-only выполнение ----------

server.registerTool(
  'execute_sql',
  {
    title: 'Выполнить SQL (read-only)',
    description:
      'Выполняет SELECT-запрос в PostgreSQL и возвращает колонки и строки результатов. ' +
      'Только чтение: INSERT/UPDATE/DELETE/DDL отклоняются.',
    inputSchema: {
      sql: z.string().describe('SQL-запрос: одиночный SELECT (допускается WITH)'),
    },
  },
  async ({ sql }) => {
    let query;
    try {
      query = normalizeReadOnly(sql);
    } catch (e) {
      return err(`Запрос отклонён: ${e.message}`);
    }
    try {
      const { rows, fields } = await pool.query(query);
      const truncated = rows.length > config.maxRows;
      return ok({
        columns: fields.map((f) => f.name),
        rows: rows.slice(0, config.maxRows),
        rowCount: rows.length,
        truncated,
      });
    } catch (e) {
      return err(`Ошибка выполнения: ${e.message}`);
    }
  },
);

// ---------- Инструмент 3: обновить кэш схемы ----------

server.registerTool(
  'refresh_schema',
  {
    title: 'Обновить схему БД',
    description:
      'Перечитывает структуру таблиц из information_schema. Вызывать после изменений DDL, ' +
      'чтобы nl_to_sql видел актуальную схему.',
    inputSchema: {},
  },
  async () => {
    await refreshSchema();
    return ok({ schema: schemaText });
  },
);

await server.connect(new StdioServerTransport());
