// Resolves @brand/* and transforms JSX so `node --test` can import the Hono views.
import { register } from "node:module";

register("./tsx-hook.mjs", import.meta.url);
