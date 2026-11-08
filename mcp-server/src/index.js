// MCP-сервер: вопрос на естественном языке -> SQL (PostgreSQL), read-only выполнение.
// Транспорт: stdio. Конфигурация: переменные окружения (см. .env.example).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { normalizeReadOnly } from './guard.js';
import { loadSchemaText } from './schema.js';
import { createSemanticLoader, renderSemanticBlock } from './semantic.js';
import { callNlToSql } from './llm.js';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });
dotenv.config({ quiet: true }); // fallback: .env из cwd, не переопределяет уже заданные переменные

const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/qlik_table',
  apiKey: process.env.MOONSHOT_API_KEY ?? '',
  baseUrl: (process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1').replace(/\/+$/, ''),
  model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
  temperature: Number(process.env.MOONSHOT_TEMPERATURE ?? 1),
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
async function refreshSchema() {
  schemaText = await loadSchemaText(pool);
}
await refreshSchema();

// семантическое ядро: автоперечитывание при изменении YAML-моделей (по отпечатку mtime)
const getSemantic = createSemanticLoader(
  join(dirname(fileURLToPath(import.meta.url)), 'models'),
  join(dirname(fileURLToPath(import.meta.url)), 'relationships.yaml'),
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
      'по базе финансовой отчётности застройщика. Запрос не выполняется — только генерируется.',
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
    try {
      const { sql, explanation } = await callNlToSql({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.temperature,
        schemaText,
        semanticBlock: renderSemanticBlock(getSemantic()),
        question,
      });
      normalizeReadOnly(sql); // модель не должна генерировать ничего кроме SELECT
      return ok({ sql, explanation });
    } catch (e) {
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
