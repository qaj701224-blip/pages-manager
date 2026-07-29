import Database from 'better-sqlite3';

// Miniflare was evaluated first, but its Node proxy bindings (`getD1Database()`
// and `getBindings()`) hung after workerd became ready with both 4.20260511.0
// and 4.20260722.0. Keep this adapter limited to the D1 surface used by
// D1PagesStore so contract tests still exercise real SQLite constraints and
// transactional behavior.
export function createD1TestDatabase() {
  const database = new Database(':memory:');

  return {
    prepare(sql) {
      return new D1TestPreparedStatement(database, sql);
    },

    async exec(sql) {
      return wrapSqliteErrors(() => database.exec(sql));
    },

    async batch(statements) {
      return wrapSqliteErrors(() =>
        database.transaction(() => statements.map((statement) => statement.executeForBatch()))()
      );
    },

    close() {
      database.close();
    },
  };
}

class D1TestPreparedStatement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new D1TestPreparedStatement(this.database, this.sql, args);
  }

  async first(columnName) {
    return wrapSqliteErrors(() => {
      const row = this.database.prepare(this.sql).get(...this.args) ?? null;
      if (columnName === undefined || row === null) return row;
      return row[columnName];
    });
  }

  async run() {
    return wrapSqliteErrors(() => this.executeRun());
  }

  async all() {
    return wrapSqliteErrors(() => this.executeAll());
  }

  executeForBatch() {
    const statement = this.database.prepare(this.sql);
    if (statement.reader) return this.executeAll(statement);
    return this.executeRun(statement);
  }

  executeRun(statement = this.database.prepare(this.sql)) {
    const result = statement.run(...this.args);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  executeAll(statement = this.database.prepare(this.sql)) {
    return {
      results: statement.all(...this.args),
      success: true,
      meta: {},
    };
  }
}

function wrapSqliteErrors(callback) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('D1_ERROR:')) {
      error.message = `D1_ERROR: ${error.message}`;
    }
    throw error;
  }
}
