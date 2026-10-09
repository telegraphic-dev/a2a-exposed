// Lets `node --test` import `*.sql?raw` the way Vite does at build time. `--import` waits for this module.
import { register } from "node:module";

await register("./sql-raw-hook.mjs", import.meta.url);
