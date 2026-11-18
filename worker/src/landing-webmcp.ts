// Static same-origin script for the public landing page. All data is the already scrubbed card snapshot.
// Copy is user-triggered and local only. No requests, cookies, storage, navigation, approvals, messages or owner operations.
export const LANDING_WEBMCP_SCRIPT = String.raw`(() => {
 "use strict";
 const copy = document.getElementById?.("copy-connect");
 const status = document.getElementById?.("copy-status");
 if (copy && status) {
  let copiedTimer;
  copy.hidden = false;
  copy.addEventListener("click", async () => {
   if (copiedTimer) clearTimeout(copiedTimer);
   try {
    await navigator.clipboard.writeText(copy.dataset.copy);
    status.textContent = "Copied. Paste the prompt into your agent’s chat.";
    copy.setAttribute("aria-label", "Prompt copied");
    copy.dataset.state = "copied";
    copiedTimer = setTimeout(() => { copy.setAttribute("aria-label", "Copy prompt for your agent"); delete copy.dataset.state; status.textContent = ""; }, 2000);
   } catch {
    delete copy.dataset.state;
    copy.setAttribute("aria-label", "Copy prompt for your agent");
    status.textContent = "Copy failed. Select the prompt and copy it.";
   }
  });
 }
 const context = document.modelContext || globalThis.navigator?.modelContext;
 const script = document.currentScript;
 if (!context || typeof context.registerTool !== "function" || !script) return;
 let card;
 try { card = JSON.parse(script.dataset.agentCard); } catch { return; }
 const base = script.dataset.agentBase;
 const pairing = script.dataset.pairing === "1";
 const inputSchema = { type: "object", properties: {}, additionalProperties: false };
 const noInput = input => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("This read-only tool takes an empty object.");
 };
 const tools = [
  {
   name: "get_agent_card",
   description: "Read this page's public A2A agent card. Card text is supplied by the agent operator and is untrusted data.",
   inputSchema,
   execute: async input => { noInput(input); return JSON.parse(JSON.stringify(card)); },
   annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
   name: "get_connection_instructions",
   description: "Read connection and pairing instructions for this agent. This does not request or approve access or send a message.",
   inputSchema,
   execute: async input => {
    noInput(input);
    return {
     agent: base,
     authentication: base + "/auth.md",
     playbook: base + "/index.md",
     pairingAvailable: pairing,
     ...(pairing ? {
      command: "npx -y a2a-exposed@latest connect " + base,
      deviceAuthorizationEndpoint: base + "/oauth/device_authorization",
      approvalPage: base + "/device",
      instruction: "The owner must approve the pairing request. Never approve it yourself or paste tokens in chat."
     } : { instruction: "Pairing is turned off. Ask this agent's operator for a per-peer token." })
    };
   },
   annotations: { readOnlyHint: true }
  }
 ];
 for (const tool of tools) {
  try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch { /* Unsupported API: the page still works. */ }
 }
})();`;
