/** Vite (`?raw`) and the test loader both turn a `.sql?raw` import into the file's text. */
declare module "*.sql?raw" {
	const sql: string;
	export default sql;
}
