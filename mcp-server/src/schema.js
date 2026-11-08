// Загрузка текстового описания схемы БД для контекста LLM.
// Сначала пробует живую интроспекцию information_schema + число строк,
// при недоступности БД использует зашитую статичную схему.

export const FALLBACK_SCHEMA = `TABLE objects (object_id integer PK, name text, city text, address text, status text, start_date date, end_date date);
TABLE buildings (building_id integer PK, object_id integer FK->objects, name text, floors integer, sections integer, plan_finish date);
TABLE channels (channel_id integer PK, name text);
TABLE units (unit_id integer PK, building_id integer FK->buildings, unit_number text, rooms integer, area numeric, floor integer, base_price numeric, status text);
TABLE dim_date (date_id date PK, year integer, month integer, month_name text, quarter integer);
TABLE construction_progress (progress_id integer PK, building_id integer FK->buildings, month date, stage text, plan_pct numeric, fact_pct numeric, plan_cost numeric, fact_cost numeric);
TABLE sales (sale_id integer PK, unit_id integer FK->units, sale_date date, channel_id integer FK->channels, price numeric, price_per_m2 numeric, discount_pct numeric, mortgage boolean, contract text);
TABLE sales_plan (plan_id integer PK, building_id integer FK->buildings, channel_id integer FK->channels, month date, plan_units integer, plan_area numeric, plan_revenue numeric);
TABLE cashflow (cashflow_id integer PK, object_id integer FK->objects, month date, plan_income numeric, fact_income numeric, plan_outcome numeric, fact_outcome numeric);`;

export async function loadSchemaText(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`);

    if (!rows.length) return FALLBACK_SCHEMA;
    const tables = new Map();
    for (const r of rows) {
      if (!tables.has(r.table_name)) tables.set(r.table_name, []);
      tables.get(r.table_name).push(`${r.column_name} ${r.data_type}`);
    }

    let counts = {};
    try {
      for (const t of tables.keys()) {
        const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
        counts[t] = c[0].n;
      }
    } catch {
      counts = {};
    }

    let out = '';
    for (const [t, cols] of tables) {
      const n = counts[t] ?? '?';
      out += `TABLE ${t} (${cols.join(', ')}); -- строк: ${n}\n`;
    }
    return out.trimEnd();
  } catch {
    return FALLBACK_SCHEMA;
  }
}

// Структурный вариант схемы для пост-валидации SQL:
// Map<table_lower, Set<column_lower>> из information_schema.
// null при недоступности БД — валидация тогда пропускается.
export async function loadSchemaColumns(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'`);
    if (!rows.length) return null;
    const map = new Map();
    for (const r of rows) {
      const t = r.table_name.toLowerCase();
      if (!map.has(t)) map.set(t, new Set());
      map.get(t).add(r.column_name.toLowerCase());
    }
    return map;
  } catch {
    return null;
  }
}
