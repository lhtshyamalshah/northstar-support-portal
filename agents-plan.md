# Agents Plan — Northstar Support Portal (as built)

This describes the AI agents **as they exist today** in `server.mjs`. It is not a
proposal; it documents the current implementation for governance and later work.

## Overview

Two single-purpose conversational agents share one `POST /api/chat` endpoint. A
deterministic keyword router in front of them picks which one answers each turn.
Both are implemented directly against the OpenAI **Responses API**
(`openai.responses.create`) — there is no agent-framework harness. Both share one
function tool, `lookup_order`.

## Router (deterministic, not a model)

- `detectBilling(message)` tests `billingPattern` (refund / duplicate charge /
  invoice / payment / billing keywords).
- Selection: `activeAgent === "billing" || detectBilling(message)` → **billing**,
  otherwise **support**. Once a conversation is on billing it stays there (sticky via
  `activeAgent`).
- `handoff` is set true the first turn support transfers to billing; the UI shows a
  "transferred to Sage" notice.

## Agent 1 — Nova (support)

- **Purpose:** general store support — order status, shipping, returns, cancellations.
- **Model:** `process.env.OPENAI_MODEL` (default `gpt-4.1-mini`).
- **System prompt:** `supportInstructions` — concise/friendly persona, embedded store
  `policies`, must call `lookup_order` before stating any order-specific fact, never
  invents data, refuses billing matters (defers to Sage), ≤3 sentences.
- **Tools:** `lookup_order`.
- **Params:** `max_output_tokens: 180`, `store: false`, `tool_choice` forced to
  `lookup_order` when an order ID is present in the message, else `auto`.

## Agent 2 — Sage (billing)

- **Purpose:** billing specialist — invoices, duplicate/double charges, payment and
  refund questions.
- **Model:** same as Nova.
- **System prompt:** `billingInstructions` — billing persona, same `policies`, same
  "call `lookup_order` before order facts / never invent" rules, states the 5–7 business
  day refund policy, ≤3 sentences.
- **Tools:** `lookup_order`.
- **Params:** same as Nova.

## Tool — `lookup_order`

- **Schema:** strict function, one required string `order_id` (e.g. `NS-1001`),
  `additionalProperties: false`.
- **Handler:** `lookupOrder(orderId)` normalises the ID and returns the matching seeded
  order (status, items, tracking, cancellation eligibility, etc.) or `{ found: false }`.
- **Guardrail:** the server only returns real tool output for order IDs the customer
  actually supplied in the conversation; any other ID returns a "not supplied" error to
  the model. Unknown IDs are also rejected **before** the model is called.

## Guardrails already in place

- No hallucinated orders: unknown / unsupplied IDs are resolved server-side before and
  during the model loop.
- Bounded model loop (max 3 tool-satisfying turns), bounded output (180 tokens), input
  trimmed to 2000 chars, history trimmed to the last 10 user/assistant turns.
- `store: false` — OpenAI does not retain the conversation.
- Deterministic demo fallback when no API key is configured.

## Governance mapping (for `governance-agent`)

- Model-call boundary: each `openai.responses.create` call in `askAgent`.
- Tool-call boundary: each `lookup_order` invocation resolved in the tool loop.
- Two agents (support, billing) + one tool (`lookup_order`) to declare in the manifest.
