export function toDb(value) {
  return value === undefined ? null : value;
}

export function toDbJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromDbJson(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(value);
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export function queryPlaceholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function quote(name) {
  return `\`${name}\``;
}

export function limitOffsetSql(limit, offset) {
  return `LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}

export async function execute(pool, sql, params = []) {
  const [rows] = await pool.execute(sql, params.map(toDb));
  return rows;
}

export async function executeResult(pool, sql, params = []) {
  const [result] = await pool.execute(sql, params.map(toDb));
  return result;
}

export function isDuplicateKeyError(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

export async function insertRowIfNotDuplicate(pool, table, row) {
  const columns = Object.keys(row);
  const insertColumns = columns.map(quote).join(', ');
  const placeholders = queryPlaceholders(columns.length);
  try {
    const result = await executeResult(
      pool,
      `INSERT INTO ${quote(table)} (${insertColumns}) VALUES (${placeholders})`,
      columns.map((column) => row[column])
    );
    return Number(result?.affectedRows || 0) > 0;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

export async function upsertRow(pool, table, row, options = {}) {
  const columns = Object.keys(row);
  const insertColumns = columns.map(quote).join(', ');
  const placeholders = queryPlaceholders(columns.length);
  const excluded = new Set(options.excludeUpdate || []);
  const updateColumns = columns.filter((column) => !excluded.has(column));
  const updateSql = updateColumns.map((column) => `${quote(column)} = VALUES(${quote(column)})`).join(', ');

  await execute(
    pool,
    [
      `INSERT INTO ${quote(table)} (${insertColumns}) VALUES (${placeholders})`,
      updateSql ? `ON DUPLICATE KEY UPDATE ${updateSql}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    columns.map((column) => row[column])
  );
}
