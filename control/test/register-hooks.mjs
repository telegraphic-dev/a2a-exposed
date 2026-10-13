// Loads `*.sql?raw` and TypeScript for `node --test`.
import { register } from "node:module";

register("./sql-raw-hook.mjs", import.meta.url);
