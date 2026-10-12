/** Split a migration file into statements. Line comments are dropped. Strings keep their semicolons. */
export function sqlStatements(sql: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: "'" | "\"" | "`" | null = null;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] ?? "";
		if (quote) {
			current += ch;
			if (ch === quote) {
				if (sql[i + 1] === quote) {
					current += sql[i + 1];
					i++;
				} else quote = null;
			}
			continue;
		}
		if (ch === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			i = end < 0 ? sql.length : end;
			continue;
		}
		if (ch === "'" || ch === "\"" || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";") {
			const statement = current.trim();
			if (statement) out.push(statement);
			current = "";
			continue;
		}
		current += ch;
	}
	const tail = current.trim();
	if (tail) out.push(tail);
	return out;
}
