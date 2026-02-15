declare module "better-sqlite3" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<BindParams extends unknown[] = unknown[], Row = unknown> {
    run(...params: BindParams): RunResult;
    get(...params: BindParams): Row | undefined;
    all(...params: BindParams): Row[];
    iterate(...params: BindParams): IterableIterator<Row>;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message?: unknown, ...additional: unknown[]) => void;
  }

  class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare<BindParams extends unknown[] = unknown[], Row = unknown>(
      sql: string
    ): Statement<BindParams, Row>;
    exec(sql: string): this;
    pragma(source: string): unknown;
    transaction<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult
    ): (...args: TArgs) => TResult;
    close(): this;
  }

  export default Database;
}
