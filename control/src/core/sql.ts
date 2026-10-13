export interface SqlStatement {
	bind(...values: unknown[]): SqlStatement;
	first<T>(): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
	all<T>(): Promise<{ results: T[] }>;
}

export interface Sql {
	prepare(query: string): SqlStatement;
	batch(statements: SqlStatement[]): Promise<unknown>;
}
