/**
 * Neutral CSS for the inbox HTML pages (`/`, `/device`, `/device/setup`, MCP consent).
 * It is inlined in one nonce'd `<style>` block. There is no external stylesheet.
 * `WORKER_THEME` (a CSS file path) replaces this module at `cf build`. See `theme-build.mjs`.
 */
export const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fafafa}
h1{font-size:1.3rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #ddd;vertical-align:top;word-break:break-all}th{width:40%;font-weight:600;word-break:normal}
label{display:block;font-weight:600;margin:.8rem 0 .3rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #888;border-radius:4px}
.b{display:flex;gap:.6rem;margin-top:1rem}button{font:inherit;padding:.5rem 1.2rem;border:0;border-radius:4px;background:#1a5fb4;color:#fff;cursor:pointer}button.d{background:#a51d2d}
h2{font-size:1.05rem;margin-top:1.5rem}ul{padding-left:1.2rem}a{color:#1a5fb4}.n{padding:.6rem .8rem;border-radius:4px}.ok{background:#e6f4ea}.error{background:#fce8e6}.info{background:#e8f0fe}.w{font-size:.9rem;color:#444}code{background:#eee;padding:0 .2rem}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #ddd}`;

export function pageStyle(): string {
	return PAGE_STYLE;
}
