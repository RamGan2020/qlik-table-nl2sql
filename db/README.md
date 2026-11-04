# База данных проекта: финансовая отчётность застройщика

PostgreSQL 16 в Docker (`qlik_table_postgres`), база `qlik_table`.

Подключение: `postgresql://postgres:postgres@localhost:5433/qlik_table`

## Файлы

- `db/schema.sql` — DDL: таблицы + индексы (пересоздаёт всё при повторном запуске)
- `db/seed.sql` — генерация тестовых данных (детерминированная, `setseed(0.42)` — повторный запуск даёт те же данные)

## Схема (звезда)

| Таблица | Тип | Назначение |
|---|---|---|
| `objects` | измерение | 3 ЖК: строится (средняя стадия), строится (ранняя), сдан |
| `buildings` | измерение | 8 корпусов (этажность, секции, плановая сдача) |
| `units` | измерение | 254 квартиры: комнаты, площадь, этаж, стартовая цена/м², статус |
| `channels` | измерение | 5 каналов: сайт, офис, агентства, ипотечный брокер, реклама |
| `dim_date` | измерение | календарь 2023–2028 (год, месяц, квартал, имя месяца) |
| `construction_progress` | факт | помесячно по корпусам: этап, план/факт % готовности, план/факт затраты |
| `sales` | факт | 160 сделок: дата, канал, цена, скидка, ипотека, тип договора |
| `sales_plan` | факт | план продаж помесячно по корпусам и каналам (шт/м²/руб) |
| `cashflow` | факт | помесячно по объектам: поступления и затраты, план/факт |

## Контрольная сводка данных

Продано 160 квартир (63%), свободно 83, брони 12.
По объектам: Заречный 43%, Северный парк 79%, Городской квартал 77% (сдан).
Готовность корпусов — от 30% (коробка) до 100%, план/факт продаж по месяцам 71–107%.

## Примеры запросов под дашборды

Ход строительства (план vs факт по корпусам):

```sql
SELECT o.name, b.name, p.month, p.stage, p.plan_pct, p.fact_pct
FROM construction_progress p
JOIN buildings b ON b.building_id = p.building_id
JOIN objects o ON o.object_id = b.object_id
WHERE p.month = date_trunc('month', CURRENT_DATE)::date;
```

Выполнение плана продаж по месяцам:

```sql
SELECT sp.month, sum(sp.plan_revenue) AS plan,
       (SELECT sum(s.price) FROM sales s
         JOIN units u ON u.unit_id = s.unit_id
         JOIN buildings b ON b.building_id = u.building_id
        WHERE date_trunc('month', s.sale_date) = sp.month) AS fact
FROM sales_plan sp GROUP BY sp.month ORDER BY 1;
```

Эффективность каналов:

```sql
SELECT c.name, count(s.sale_id) AS deals, sum(s.price) AS revenue
FROM channels c LEFT JOIN sales s ON s.channel_id = c.channel_id
GROUP BY c.name ORDER BY revenue DESC;
```

## Управление

Пересоздать данные:

```bash
docker exec -i qlik_table_postgres psql -U postgres -d qlik_table < db/schema.sql
docker exec -i qlik_table_postgres psql -U postgres -d qlik_table < db/seed.sql
```

Контейнер: `docker compose stop` / `docker compose up -d` (в корне проекта).

## Замечания

- План продаж в `sales_plan` лежит и в будущие месяцы (до середины 2028) — для сравнения «факт vs план» фильтруйте по `month <= CURRENT_DATE`.
- Генерация привязана к текущей дате: при перезапуске `seed.sql` в другой день/месяц данные «сдвинутся» относительно дат.
