-- ============================================================
-- Схема БД для дашбордов застройщика
-- Справочники: objects, buildings, units, channels, dim_date
-- Факты: construction_progress, sales, reservations, sales_plan, cashflow
-- ============================================================
SET client_encoding = 'UTF8';

DROP TABLE IF EXISTS reservations        CASCADE;
DROP TABLE IF EXISTS cashflow              CASCADE;
DROP TABLE IF EXISTS sales_plan            CASCADE;
DROP TABLE IF EXISTS sales                 CASCADE;
DROP TABLE IF EXISTS construction_progress CASCADE;
DROP TABLE IF EXISTS units                 CASCADE;
DROP TABLE IF EXISTS channels              CASCADE;
DROP TABLE IF EXISTS buildings             CASCADE;
DROP TABLE IF EXISTS objects               CASCADE;
DROP TABLE IF EXISTS dim_date              CASCADE;

-- ---------- Измерения ----------

CREATE TABLE objects (
    object_id   SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    city        TEXT NOT NULL,
    address     TEXT,
    status      TEXT NOT NULL,              -- строится / сдан
    start_date  DATE NOT NULL,              -- начало строительства
    end_date    DATE NOT NULL               -- плановая сдача
);

CREATE TABLE buildings (
    building_id  SERIAL PRIMARY KEY,
    object_id    INT NOT NULL REFERENCES objects(object_id),
    name         TEXT NOT NULL,             -- Корпус 1
    floors       INT NOT NULL,
    sections     INT NOT NULL,
    plan_finish  DATE NOT NULL              -- плановая дата завершения
);

CREATE TABLE channels (
    channel_id SERIAL PRIMARY KEY,
    name       TEXT NOT NULL
);

CREATE TABLE units (
    unit_id     SERIAL PRIMARY KEY,
    building_id INT NOT NULL REFERENCES buildings(building_id),
    unit_number TEXT NOT NULL,
    rooms       INT NOT NULL,               -- 0 = студия
    area        NUMERIC(6,2) NOT NULL,      -- площадь, м²
    floor       INT NOT NULL,
    base_price  NUMERIC(12,2) NOT NULL,     -- стартовая цена за м²
    status      TEXT NOT NULL DEFAULT 'available'   -- available / sold / reserved
);

CREATE TABLE dim_date (
    date_id    DATE PRIMARY KEY,
    year       INT NOT NULL,
    month      INT NOT NULL,
    month_name TEXT NOT NULL,
    quarter    INT NOT NULL
);

-- ---------- Факты ----------

-- Ход строительства: помесячно по корпусам
CREATE TABLE construction_progress (
    progress_id SERIAL PRIMARY KEY,
    building_id INT NOT NULL REFERENCES buildings(building_id),
    month       DATE NOT NULL,              -- первое число месяца
    stage       TEXT NOT NULL,              -- текущий этап работ
    plan_pct    NUMERIC(5,2) NOT NULL,      -- план готовности, % (нарастающий)
    fact_pct    NUMERIC(5,2) NOT NULL,      -- факт готовности, % (нарастающий)
    plan_cost   NUMERIC(14,2) NOT NULL,     -- плановые затраты за месяц
    fact_cost   NUMERIC(14,2) NOT NULL,     -- фактические затраты за месяц
    UNIQUE (building_id, month)
);

-- Продажи: транзакционный факт
CREATE TABLE sales (
    sale_id      SERIAL PRIMARY KEY,
    unit_id      INT NOT NULL REFERENCES units(unit_id),
    sale_date    DATE NOT NULL,
    channel_id   INT NOT NULL REFERENCES channels(channel_id),
    price        NUMERIC(14,2) NOT NULL,    -- цена сделки
    price_per_m2 NUMERIC(12,2) NOT NULL,
    discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    mortgage     BOOLEAN NOT NULL DEFAULT FALSE,
    contract     TEXT NOT NULL              -- ДДУ / Уступка права / Рассрочка
);

-- Брони: история бронирований квартир (одна строка = одно событие брони)
CREATE TABLE reservations (
    reservation_id SERIAL PRIMARY KEY,
    unit_id        INT NOT NULL REFERENCES units(unit_id),
    channel_id     INT NOT NULL REFERENCES channels(channel_id),  -- кто привлёк
    reserved_at    DATE NOT NULL,              -- дата бронирования
    expires_at     DATE NOT NULL,              -- плановая дата сгорания
    price          NUMERIC(14,2) NOT NULL,     -- цена брони (цена квартиры на момент)
    status         TEXT NOT NULL DEFAULT 'active',  -- active / converted / expired / cancelled
    sale_id        INT REFERENCES sales(sale_id)     -- сделка, если перешла; NULL иначе
);

-- План продаж: помесячно по корпусам и каналам
CREATE TABLE sales_plan (
    plan_id      SERIAL PRIMARY KEY,
    building_id  INT NOT NULL REFERENCES buildings(building_id),
    channel_id   INT NOT NULL REFERENCES channels(channel_id),
    month        DATE NOT NULL,
    plan_units   INT NOT NULL,
    plan_area    NUMERIC(10,2) NOT NULL,    -- план по площади, м²
    plan_revenue NUMERIC(14,2) NOT NULL,    -- план по выручке
    UNIQUE (building_id, channel_id, month)
);

-- Cash-flow: помесячно по объектам (поступления от продаж / затраты на стройку)
CREATE TABLE cashflow (
    cashflow_id  SERIAL PRIMARY KEY,
    object_id    INT NOT NULL REFERENCES objects(object_id),
    month        DATE NOT NULL,
    plan_income  NUMERIC(14,2) NOT NULL,
    fact_income  NUMERIC(14,2),             -- NULL для будущих месяцев
    plan_outcome NUMERIC(14,2) NOT NULL,
    fact_outcome NUMERIC(14,2),
    UNIQUE (object_id, month)
);

-- ---------- Индексы ----------

CREATE INDEX idx_units_building    ON units(building_id);
CREATE INDEX idx_units_status      ON units(status);
CREATE INDEX idx_progress_bld_m    ON construction_progress(building_id, month);
CREATE INDEX idx_sales_date        ON sales(sale_date);
CREATE INDEX idx_sales_channel     ON sales(channel_id);
CREATE INDEX idx_reserv_unit       ON reservations(unit_id);
CREATE INDEX idx_reserv_channel    ON reservations(channel_id);
CREATE INDEX idx_reserv_status     ON reservations(status);
CREATE INDEX idx_reserv_date       ON reservations(reserved_at);
CREATE INDEX idx_sales_plan_bld_m  ON sales_plan(building_id, month);
CREATE INDEX idx_cashflow_obj_m    ON cashflow(object_id, month);
