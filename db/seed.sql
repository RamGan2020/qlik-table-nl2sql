-- ============================================================
-- Тестовые данные для дашбордов застройщика
-- Детерминировано (setseed): повторный запуск даёт те же данные.
-- Порядок важен: справочники -> прогресс -> план продаж ->
-- факт продаж -> брони -> cash-flow.
-- ============================================================
SET client_encoding = 'UTF8';
SELECT setseed(0.42);

-- ---------- Объекты / корпуса / каналы ----------

INSERT INTO objects (name, city, address, status, start_date, end_date) VALUES
('ЖК «Северный парк»',     'Москва', 'ул. Северная, 12',   'строится', '2024-06-01', '2027-06-30'),
('ЖК «Заречный»',          'Москва', 'пр. Заречный, 5',    'строится', '2026-04-01', '2028-06-30'),
('ЖК «Городской квартал»', 'Москва', 'ул. Центральная, 1', 'сдан',     '2023-09-01', '2026-09-30');

INSERT INTO buildings (object_id, name, floors, sections, plan_finish) VALUES
(1, 'Корпус 1', 12, 2, '2026-12-31'),
(1, 'Корпус 2', 14, 2, '2027-03-31'),
(1, 'Корпус 3', 16, 3, '2027-06-30'),
(2, 'Корпус 1', 10, 2, '2027-06-30'),
(2, 'Корпус 2', 15, 3, '2028-06-30'),
(2, 'Корпус 3', 15, 3, '2028-06-30'),
(3, 'Дом 1',    11, 2, '2026-03-31'),
(3, 'Дом 2',    11, 2, '2026-09-30');

INSERT INTO channels (name) VALUES
('Сайт застройщика'),
('Офис продаж'),
('Агентства недвижимости'),
('Ипотечный брокер'),
('Рекламные площадки');

-- ---------- Календарь 2023–2028 ----------

INSERT INTO dim_date
SELECT d::date,
       extract(year    FROM d)::int,
       extract(month   FROM d)::int,
       (ARRAY['Январь','Февраль','Март','Апрель','Май','Июнь',
               'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'])[extract(month FROM d)::int],
       extract(quarter FROM d)::int
FROM generate_series('2023-01-01'::date, '2028-12-31'::date, interval '1 day') AS d;

-- ---------- Квартиры ----------

DO $$
DECLARE
    r       RECORD;
    v_floor INT;
    v_sec   INT;
    v_i     INT := 0;
    v_rooms INT;
    v_area  NUMERIC;
    v_base  NUMERIC;
    v_pattern INT[] := ARRAY[0, 1, 1, 2, 2, 3];   -- студия, 1к, 1к, 2к, 2к, 3к
BEGIN
    FOR r IN SELECT * FROM buildings LOOP
        v_base := CASE r.object_id WHEN 1 THEN 185000 WHEN 2 THEN 150000 ELSE 220000 END;
        FOR v_floor IN 1 .. r.floors LOOP
            FOR v_sec IN 1 .. r.sections LOOP
                v_rooms := v_pattern[1 + v_i % array_length(v_pattern, 1)];
                v_area := CASE v_rooms
                              WHEN 0 THEN 20 + random() * 8
                              WHEN 1 THEN 34 + random() * 11
                              WHEN 2 THEN 52 + random() * 16
                              ELSE        76 + random() * 20
                          END;
                INSERT INTO units (building_id, unit_number, rooms, area, floor, base_price)
                VALUES (r.building_id,
                        'С' || v_sec || '-' || lpad(v_floor::text, 2, '0'),
                        v_rooms,
                        round(v_area, 1),
                        v_floor,
                        round(v_base * (0.97 + random() * 0.06)::numeric * (1 + 0.10 * v_floor::numeric / r.floors), 0));
                v_i := v_i + 1;
            END LOOP;
        END LOOP;
    END LOOP;
END $$;

-- ---------- Ход строительства (план/факт по корпусам) ----------

DO $$
DECLARE
    r              RECORD;
    v_start        DATE;
    v_months_total INT;     -- месяцев от старта до плановой сдачи
    v_months_fact  INT;     -- месяцев от старта до текущего (или сдачи)
    v_i            INT;
    m              DATE;
    v_perf         NUMERIC; -- темп строительства корпуса (0.88–1.10)
    v_budget       NUMERIC; -- бюджет корпуса, ₽
    v_plan_month   NUMERIC;
    v_plan         NUMERIC;
    v_fact         NUMERIC;
    v_stage        TEXT;
BEGIN
    FOR r IN SELECT b.*, o.start_date AS obj_start
             FROM buildings b JOIN objects o ON o.object_id = b.object_id LOOP
        v_start := date_trunc('month', r.obj_start)::date;
        v_months_total := ((extract(year FROM r.plan_finish) - extract(year FROM v_start)) * 12
                         + extract(month FROM r.plan_finish) - extract(month FROM v_start))::int + 1;
        v_months_fact  := least(v_months_total,
                                ((extract(year FROM CURRENT_DATE) - extract(year FROM v_start)) * 12
                               + extract(month FROM CURRENT_DATE) - extract(month FROM v_start))::int + 1);
        v_perf   := 0.88 + random() * 0.22;
        v_budget := 320000000 * (1 + random() * 0.6);
        v_plan_month := v_budget / v_months_total;
        FOR v_i IN 1 .. v_months_fact LOOP
            m := (v_start + ((v_i - 1) || ' months')::interval)::date;
            v_plan := round(least(100, 100.0 * v_i / v_months_total), 1);
            v_fact := round(greatest(0, least(100, v_plan * v_perf + (random() * 4 - 2)::numeric)), 1);
            IF v_i = v_months_total THEN
                v_fact := 100;   -- срок сдачи наступил — корпус завершён
            END IF;
            v_stage := CASE
                           WHEN v_plan <  8 THEN 'Подготовка территории'
                           WHEN v_plan < 20 THEN 'Фундамент'
                           WHEN v_plan < 50 THEN 'Возведение коробки'
                           WHEN v_plan < 65 THEN 'Кровля и фасад'
                           WHEN v_plan < 85 THEN 'Внутренние инженерные сети'
                           WHEN v_plan < 97 THEN 'Отделка мест общего пользования'
                           ELSE 'Благоустройство'
                       END;
            INSERT INTO construction_progress (building_id, month, stage, plan_pct, fact_pct, plan_cost, fact_cost)
            VALUES (r.building_id, m, v_stage, v_plan, v_fact,
                    round(v_plan_month, 2),
                    round(v_plan_month * (0.85 + random() * 0.30)::numeric * (v_fact / nullif(v_plan, 0)), 2));
        END LOOP;
    END LOOP;
END $$;

-- ---------- План продаж (по корпусам и каналам, до середины 2028) ----------

DO $$
DECLARE
    r             RECORD;
    v_sales_start DATE;
    m             DATE;
    v_ms          INT;
    v_base_demand INT;
    v_units_total INT;
    v_cum         INT;
    v_ch          INT;
    v_plan_units  INT;
    v_plan_sum    INT;
    v_avg_area    NUMERIC;
    v_base_price  NUMERIC;
    v_size_factor NUMERIC;
    v_w NUMERIC[] := ARRAY[0.30, 0.20, 0.25, 0.15, 0.10];   -- доли каналов
BEGIN
    FOR r IN SELECT b.*, o.start_date AS obj_start
             FROM buildings b JOIN objects o ON o.object_id = b.object_id LOOP
        v_sales_start := (date_trunc('month', r.obj_start)::date + interval '1 month')::date;
        SELECT count(*), avg(area) INTO v_units_total, v_avg_area FROM units WHERE building_id = r.building_id;
        v_base_price := CASE r.object_id WHEN 1 THEN 185000 WHEN 2 THEN 150000 ELSE 220000 END;
        v_size_factor := v_units_total / 32.0;   -- средний корпус ~32 квартиры
        v_cum := 0;
        m := v_sales_start;
        WHILE m <= DATE '2028-06-01' AND v_cum < v_units_total * 0.95 LOOP
            v_ms := ((extract(year FROM m) - extract(year FROM v_sales_start)) * 12
                   + extract(month FROM m) - extract(month FROM v_sales_start))::int;
            v_base_demand := CASE
                                 WHEN v_ms < 3  THEN 2
                                 WHEN v_ms < 9  THEN 4 + floor(random() * 3)::int
                                 WHEN v_ms < 15 THEN 3 + floor(random() * 3)::int
                                 ELSE 2 + floor(random() * 2)::int
                             END;
            IF extract(month FROM m) IN (1, 2)  THEN v_base_demand := greatest(1, v_base_demand - 1); END IF;
            IF extract(month FROM m) IN (9, 10) THEN v_base_demand := v_base_demand + 1; END IF;
            -- план месяца по корпусу, раскладка по каналам с джиттером;
            -- спрос затухает по мере заполнения (по накопленному плану)
            v_plan_sum := 0;
            FOR v_ch IN 1 .. 5 LOOP
                v_plan_units := round(v_base_demand * v_size_factor * 0.6
                                      * (1 - v_cum::numeric / v_units_total)
                                      * v_w[v_ch] * (0.85 + random() * 0.3));
                IF v_plan_units > 0 THEN
                    INSERT INTO sales_plan (building_id, channel_id, month, plan_units, plan_area, plan_revenue)
                    VALUES (r.building_id, v_ch, m, v_plan_units,
                            round(v_plan_units * v_avg_area, 1),
                            round(v_plan_units * v_avg_area * v_base_price * power(1.004, v_ms) * 1.03, 0));
                    v_plan_sum := v_plan_sum + v_plan_units;
                END IF;
            END LOOP;
            v_cum := v_cum + v_plan_sum;
            m := (m + interval '1 month')::date;
        END LOOP;
    END LOOP;
END $$;

-- ---------- Факт продаж + брони ----------

DO $$
DECLARE
    r             RECORD;
    m             DATE;
    v_sales_start DATE;
    v_ms          INT;
    v_demand      INT;
    v_k           INT;
    v_unit        RECORD;
    v_rnd         FLOAT;
    v_channel     INT;
    v_discount    NUMERIC;
    v_price_m2    NUMERIC;
    v_contract    TEXT;
    v_size_factor NUMERIC;
    v_sold_cnt    INT;
    v_total_cnt   INT;
BEGIN
    FOR r IN SELECT b.*, o.start_date AS obj_start
             FROM buildings b JOIN objects o ON o.object_id = b.object_id LOOP
        v_sales_start := (date_trunc('month', r.obj_start)::date + interval '1 month')::date;
        SELECT count(*) INTO v_total_cnt FROM units WHERE building_id = r.building_id;
        v_size_factor := v_total_cnt / 32.0;
        m := v_sales_start;
        WHILE m <= date_trunc('month', CURRENT_DATE)::date LOOP
            v_ms := ((extract(year FROM m) - extract(year FROM v_sales_start)) * 12
                   + extract(month FROM m) - extract(month FROM v_sales_start))::int;
            v_demand := CASE
                            WHEN v_ms < 3  THEN 2
                            WHEN v_ms < 9  THEN 4 + floor(random() * 3)::int
                            WHEN v_ms < 15 THEN 3 + floor(random() * 3)::int
                            ELSE 2 + floor(random() * 2)::int
                        END;
            IF extract(month FROM m) IN (1, 2)  THEN v_demand := greatest(1, v_demand - 1); END IF;
            IF extract(month FROM m) IN (9, 10) THEN v_demand := v_demand + 1; END IF;
            -- спрос затухает по мере распродажи корпуса
            SELECT count(*) FILTER (WHERE status = 'sold') INTO v_sold_cnt
            FROM units WHERE building_id = r.building_id;
            v_demand := round(v_demand * v_size_factor * 0.6 * (1 - v_sold_cnt::numeric / v_total_cnt));
            FOR v_k IN 1 .. v_demand LOOP
                SELECT * INTO v_unit
                FROM units
                WHERE building_id = r.building_id AND status = 'available'
                ORDER BY random() LIMIT 1;
                IF NOT FOUND THEN EXIT; END IF;   -- корпус распродан

                v_rnd := random();
                v_channel := CASE WHEN v_rnd < 0.30 THEN 1 WHEN v_rnd < 0.50 THEN 2
                                  WHEN v_rnd < 0.75 THEN 3 WHEN v_rnd < 0.90 THEN 4 ELSE 5 END;
                v_discount := CASE WHEN random() < 0.30 THEN 0 ELSE round((random() * 8)::numeric, 1) END;
                v_price_m2 := round(v_unit.base_price * power(1.004, v_ms)
                                    * (0.98 + random() * 0.04)::numeric * (1 - v_discount / 100), 0);
                v_rnd := random();
                v_contract := CASE WHEN v_rnd < 0.85 THEN 'ДДУ'
                                   WHEN v_rnd < 0.95 THEN 'Уступка права'
                                   ELSE 'Рассрочка' END;

                UPDATE units SET status = 'sold' WHERE unit_id = v_unit.unit_id;
                INSERT INTO sales (unit_id, sale_date, channel_id, price, price_per_m2, discount_pct, mortgage, contract)
                VALUES (v_unit.unit_id,
                        make_date(extract(year FROM m)::int, extract(month FROM m)::int, 1 + floor(random() * 27)::int),
                        v_channel,
                        round(v_price_m2 * v_unit.area, 2),
                        v_price_m2,
                        v_discount,
                        random() < 0.6,
                        v_contract);
            END LOOP;
            m := (m + interval '1 month')::date;
        END LOOP;
    END LOOP;
END $$;

-- ---------- Брони: история (активные / сгоревшие / отменённые / перешедшие в сделку) ----------

    DO $$
    DECLARE
        v_sale      RECORD;
        v_unit      RECORD;
        v_hist      RECORD;
        v_channel   INT;
        v_price     NUMERIC;
        v_rnd       FLOAT;
        v_reserved  DATE;
        v_expires   DATE;
        v_status    TEXT;
        v_active    INT[] := ARRAY[]::INT[];
    BEGIN
        -- 1) каждая четвёртая сделка выросла из брони: бронь конвертировалась в сделку
        FOR v_sale IN
            SELECT s.sale_id, s.unit_id, s.sale_date, s.channel_id, s.price
            FROM sales s
            WHERE (s.sale_id % 4) = 0          -- детерминированная выборка без random()
        LOOP
            v_reserved := v_sale.sale_date - (3 + floor(random() * 18)::int);  -- бронь жила 3–20 дней
            INSERT INTO reservations (unit_id, channel_id, reserved_at, expires_at, price, status, sale_id)
            VALUES (v_sale.unit_id, v_sale.channel_id, v_reserved, v_reserved + 14,
                    round(v_sale.price * (0.995 + random() * 0.01)::numeric, 2), 'converted', v_sale.sale_id);
        END LOOP;

        -- 2) история поверх части конвертировавшихся: раньше на той же квартире бронь сгорела/отменена
        FOR v_hist IN
            SELECT r.unit_id, r.reserved_at
            FROM reservations r
            WHERE r.status = 'converted' AND (r.reservation_id % 3) = 0
        LOOP
            v_reserved := v_hist.reserved_at - (20 + floor(random() * 90)::int);
            v_status   := CASE WHEN random() < 0.55 THEN 'expired' ELSE 'cancelled' END;
            v_rnd := random();
            v_channel  := 1 + floor(v_rnd * 5)::int;
            SELECT round(u.base_price * u.area * (0.95 + random() * 0.08)::numeric, 2)
            INTO v_price
            FROM units u WHERE u.unit_id = v_hist.unit_id;
            INSERT INTO reservations (unit_id, channel_id, reserved_at, expires_at, price, status)
            VALUES (v_hist.unit_id, 1 + floor(random() * 5)::int, v_reserved, v_reserved + 14,
                    v_price, v_status);
        END LOOP;

        -- 3) активные брони — ровно те 12 квартир, что получают status = 'reserved' ниже
        FOR v_unit IN
            SELECT unit_id, area, base_price FROM units
            WHERE status = 'available'
            ORDER BY random() LIMIT 12
        LOOP
            v_reserved := CURRENT_DATE - floor(random() * 10)::int;
            v_rnd := random();
            v_channel  := CASE WHEN v_rnd < 0.30 THEN 1 WHEN v_rnd < 0.50 THEN 2
                               WHEN v_rnd < 0.75 THEN 3 WHEN v_rnd < 0.90 THEN 4 ELSE 5 END;
            INSERT INTO reservations (unit_id, channel_id, reserved_at, expires_at, price, status)
            VALUES (v_unit.unit_id, v_channel, v_reserved, v_reserved + 14,
                    round(v_unit.base_price * v_unit.area * (0.99 + random() * 0.02)::numeric, 2), 'active');
            v_active := v_active || v_unit.unit_id;
        END LOOP;

        UPDATE units SET status = 'reserved' WHERE unit_id = ANY(v_active);

        -- 4) архив: сгоревшие и отменённые брони последних ~14 месяцев по свободным квартирам
        FOR v_unit IN
            SELECT unit_id, area, base_price FROM units
            WHERE status = 'available' AND NOT (unit_id = ANY(v_active))
            ORDER BY random() LIMIT 16
        LOOP
            v_reserved := CURRENT_DATE - (20 + floor(random() * 400)::int);
            v_status   := CASE WHEN random() < 0.60 THEN 'expired' ELSE 'cancelled' END;
            v_rnd := random();
            v_channel  := CASE WHEN v_rnd < 0.30 THEN 1 WHEN v_rnd < 0.50 THEN 2
                               WHEN v_rnd < 0.75 THEN 3 WHEN v_rnd < 0.90 THEN 4 ELSE 5 END;
            INSERT INTO reservations (unit_id, channel_id, reserved_at, expires_at, price, status)
            VALUES (v_unit.unit_id, v_channel, v_reserved, v_reserved + 14,
                    round(v_unit.base_price * v_unit.area * (0.94 + random() * 0.08)::numeric, 2), v_status);
        END LOOP;
END $$;

-- ---------- Cash-flow (поступления / затраты, план/факт) ----------

DO $$
DECLARE
    r               RECORD;
    m               DATE;
    v_start         DATE;
    v_cur_month     DATE := date_trunc('month', CURRENT_DATE)::date;
    v_plan_rev      NUMERIC;
    v_prev_plan_rev NUMERIC;
    v_fact_rev      NUMERIC;
    v_prev_fact_rev NUMERIC;
    v_plan_cost     NUMERIC;
    v_fact_cost     NUMERIC;
BEGIN
    FOR r IN SELECT * FROM objects LOOP
        SELECT min(p.month) INTO v_start
        FROM construction_progress p
        JOIN buildings b ON b.building_id = p.building_id
        WHERE b.object_id = r.object_id;
        m := v_start;
        WHILE m <= DATE '2028-06-01' LOOP
            SELECT COALESCE(sum(sp.plan_revenue), 0) INTO v_plan_rev
            FROM sales_plan sp JOIN buildings b ON b.building_id = sp.building_id
            WHERE b.object_id = r.object_id AND sp.month = m;

            SELECT COALESCE(sum(sp.plan_revenue), 0) INTO v_prev_plan_rev
            FROM sales_plan sp JOIN buildings b ON b.building_id = sp.building_id
            WHERE b.object_id = r.object_id AND sp.month = (m - interval '1 month')::date;

            SELECT COALESCE(sum(s.price), 0) INTO v_fact_rev
            FROM sales s
            JOIN units u ON u.unit_id = s.unit_id
            JOIN buildings b ON b.building_id = u.building_id
            WHERE b.object_id = r.object_id AND date_trunc('month', s.sale_date)::date = m;

            SELECT COALESCE(sum(s.price), 0) INTO v_prev_fact_rev
            FROM sales s
            JOIN units u ON u.unit_id = s.unit_id
            JOIN buildings b ON b.building_id = u.building_id
            WHERE b.object_id = r.object_id AND date_trunc('month', s.sale_date)::date = (m - interval '1 month')::date;

            SELECT COALESCE(sum(p.plan_cost), 0), COALESCE(sum(p.fact_cost), 0)
            INTO v_plan_cost, v_fact_cost
            FROM construction_progress p
            JOIN buildings b ON b.building_id = p.building_id
            WHERE b.object_id = r.object_id AND p.month = m;

            INSERT INTO cashflow (object_id, month, plan_income, fact_income, plan_outcome, fact_outcome)
            VALUES (r.object_id, m,
                    round(v_plan_rev * 0.6 + v_prev_plan_rev * 0.4, 2),
                    CASE WHEN m > v_cur_month THEN NULL
                         ELSE round(v_fact_rev * 0.6 + v_prev_fact_rev * 0.4, 2) END,
                    round(v_plan_cost * 1.08, 2),   -- +8% коммерческие расходы
                    CASE WHEN m > v_cur_month THEN NULL
                         ELSE round(v_fact_cost * (1.0 + random() * 0.15)::numeric, 2) END);
            m := (m + interval '1 month')::date;
        END LOOP;
    END LOOP;
END $$;

-- ---------- Итоги ----------

SELECT 'objects'               AS table, count(*) FROM objects
UNION ALL SELECT 'buildings',   count(*) FROM buildings
UNION ALL SELECT 'units',       count(*) FROM units
UNION ALL SELECT 'channels',    count(*) FROM channels
UNION ALL SELECT 'dim_date',    count(*) FROM dim_date
UNION ALL SELECT 'construction_progress', count(*) FROM construction_progress
UNION ALL SELECT 'sales',       count(*) FROM sales
UNION ALL SELECT 'reservations', count(*) FROM reservations
UNION ALL SELECT 'sales_plan',  count(*) FROM sales_plan
UNION ALL SELECT 'cashflow',    count(*) FROM cashflow
ORDER BY 1;
