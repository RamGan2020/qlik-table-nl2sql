# qlik-table-nl2sql

**NL → SQL для финансовой отчётности застройщика:** вопрос на русском языке → SQL-запрос к PostgreSQL → таблица с результатом. MCP-сервер (Model Context Protocol) для Kimi Code CLI, Claude Desktop, Cursor и других MCP-клиентов.

An MCP server that turns Russian natural-language questions into SQL against a real-estate developer's financial reporting database (PostgreSQL), with read-only execution and a semantic metrics layer. Built with Node.js and the Kimi/Moonshot LLM.

## Возможности

- **Вопрос → SQL → результат.** Пользователь пишет по-русски («Продажи по каналам за 2026 год»), получает SQL и данные. Поддерживается режим факторного анализа («почему недобор плана? разложи на факторы»).
- **Read-only по умолчанию:** только `SELECT`/`WITH`, двухуровневая защита (guard + read-only сессия PostgreSQL).
- **Семантическое ядро:** YAML-модели таблиц (`mcp-server/src/models/*.yaml`) и реестр связей (`src/relationships.yaml`): измерения и типизированные меры с синонимами, автообновление без перезапуска.
- **Тестовая база застройщика:** 3 ЖК, 8 корпусов, 254 квартиры, продажи с планом/фактом, ход строительства, cash-flow (данные генерируются детерминированно).

## Состав

| Путь | Описание |
|---|---|
| `docker-compose.yml` | PostgreSQL 16 в Docker (порт 5433) |
| `db/` | Схема БД (звезда) + генератор тестовых данных + описание |
| `mcp-server/` | Код MCP-сервера: инструменты `nl_to_sql`, `execute_sql`, `refresh_schema` |
| `mcp-server/src/models/`, `mcp-server/src/relationships.yaml` | Семантическое ядро: модели таблиц и связи, редактируются аналитиками |
| `docs/cheatsheet.md` | Шпаргалка для руководства и аналитиков (как спрашивать, каталог вопросов) |
| `.kimi-code/mcp.json` | Готовая регистрация для Kimi Code CLI |

## Быстрый старт

```bash
docker compose up -d          # PostgreSQL с тестовыми данными
cd mcp-server
npm install
cp .env.example .env          # вписать MOONSHOT_API_KEY (Kimi/Moonshot)
npm test                      # 6 проверок, включая отказ от DELETE
node test/e2e.js "Продажи по каналам за 2026 год"
```

Подключение к MCP-клиенту (stdio): `node mcp-server/src/index.js` — см. примеры конфигурации в `mcp-server/README.md`.

## Ключи API

Подходит ключ подписки **Kimi Code** (`https://api.kimi.ai/coding/v1`, модели `k3-256k`, `kimi-for-coding`) или платформы **Moonshot** (`https://api.moonshot.ai/v1`, pay-as-you-go). Подробности — `mcp-server/README.md`.

## Ограничения

- Ответ занимает 30 с — 2 мин (вызов LLM); это ad-hoc аналитика, не real-time дашборды.
- Генерируемый SQL стоит проверять для управленческих решений; сервер показывает SQL вместе с результатом.
- Данные тестовые (генератор `db/seed.sql`), диапазон 2023–2028.

---

Подробная инструкция для пользователей: [`docs/cheatsheet.md`](docs/cheatsheet.md).
Техническая документация сервера: [`mcp-server/README.md`](mcp-server/README.md).
