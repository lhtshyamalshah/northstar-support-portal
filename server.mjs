import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import express from "express";
import OpenAI from "openai";

loadEnvFile();

// Governance must load after the env file so platform-injected configuration is visible.
const {
  GovernanceDeniedError,
  GovernedSession,
  ORDER_LOOKUP_TOOL_DID,
  classifyFailure,
  deriveSessionId,
  estimateCostUsd,
  estimateTokens,
  initGovernance,
  withPromptCanaries
} = await import("./governance.mjs");

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const app = express();

// This is intentionally in memory for the prototype. It resets when the server restarts.
const orders = [
  { id: "NS-1001", customer: "Ava Patel", items: ["Cloud Knit Cardigan", "Everyday Tee"], status: "processing", total: 138.0, placedAt: "2026-08-31", shipping: "Standard" },
  { id: "NS-1002", customer: "Noah Williams", items: ["Linen Travel Set"], status: "shipped", total: 124.0, placedAt: "2026-08-29", shipping: "Express", tracking: "NSX 884 112 006" },
  { id: "NS-1003", customer: "Mia Chen", items: ["Canvas Market Tote", "Wool Cap"], status: "delivered", total: 76.5, placedAt: "2026-08-25", shipping: "Standard", deliveredAt: "2026-08-30" },
  { id: "NS-1004", customer: "Ethan Rodriguez", items: ["Essential Oxford Shirt"], status: "refunded", total: 89.0, placedAt: "2026-08-19", shipping: "Standard", refundedAt: "2026-08-28" },
  { id: "NS-1005", customer: "Sophia Davis", items: ["Weekend Crewneck", "Ribbed Beanie"], status: "shipped", total: 112.0, placedAt: "2026-09-01", shipping: "Express", tracking: "NSX 884 112 391" },
  { id: "NS-1006", customer: "Liam Johnson", items: ["Relaxed Chino"], status: "processing", total: 98.0, placedAt: "2026-09-03", shipping: "Standard" },
  { id: "NS-1007", customer: "Olivia Martin", items: ["Merino Half-Zip"], status: "delivered", total: 145.0, placedAt: "2026-08-22", shipping: "Express", deliveredAt: "2026-08-25" },
  { id: "NS-1008", customer: "James Wilson", items: ["Studio Overshirt", "Everyday Tee"], status: "refunded", total: 154.0, placedAt: "2026-08-17", shipping: "Standard", refundedAt: "2026-08-27" },
  { id: "NS-1009", customer: "Isabella Moore", items: ["Soft Shell Jacket"], status: "shipped", total: 168.0, placedAt: "2026-08-30", shipping: "Standard", tracking: "NS 601 833 028" },
  { id: "NS-1010", customer: "Benjamin Lee", items: ["Waffle Long Sleeve", "Canvas Market Tote"], status: "delivered", total: 92.0, placedAt: "2026-08-20", shipping: "Standard", deliveredAt: "2026-08-26" }
];

const policies = `
Store policies:
- Standard shipping takes 3–5 business days; express shipping takes 1–2 business days.
- Returns are accepted within 30 days of delivery. Refunds are processed in 5–7 business days to the original payment method.
- An order can be cancelled only while its status is processing.
`;

const supportInstructions = withPromptCanaries(`
You are Nova, a concise, friendly online-store support assistant.
${policies}
For any question asking about a specific order, status, delivery, cancellation, item, or shipment, call lookup_order with the supplied order ID before answering. Never create, guess, or infer order details. If no valid ID has been provided, politely ask for it. Only describe data returned by the tool as an order fact.
Do not handle billing matters (refund requests or timing, duplicate/double charges, payment issues, or invoices). Those belong to a billing specialist. A server router normally sends them there, but if one reaches you, say you are transferring the customer to billing.
Keep every answer to at most three short sentences. Do not offer actions the store cannot perform.
`);

const billingInstructions = withPromptCanaries(`
You are Sage, the billing specialist for an online store. You handle invoices, duplicate/double charges, payment questions, and refund questions.
${policies}
For specific-order questions, call lookup_order with a supplied order ID before describing its status. Never make up order details, payment details, charge amounts, invoice availability, refund dates, or actions. If needed, ask for the order ID and say a billing teammate can review the account securely.
For refunds, clearly state that refunds are processed in 5–7 business days to the original payment method. Keep every reply concise, friendly, and under three short sentences.
`);

const orderLookupTool = {
  type: "function",
  name: "lookup_order",
  description: "Look up a store order by its exact order ID before discussing any order-specific details.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      order_id: {
        type: "string",
        description: "Exact order ID supplied by the customer, for example NS-1001."
      }
    },
    required: ["order_id"],
    additionalProperties: false
  }
};

const billingPattern = /\b(refund(?:ed|ing)?|double\s*charge|duplicate\s*charge|charged\s+twice|invoice|billing|payment\s+(?:issue|problem)|card\s+(?:charge|payment))\b/i;
const orderIdPattern = /\b(?:NS[-\s]?)?\d{4}\b/i;

function loadEnvFile() {
  // Keeps local setup dependency-free; real environment values still take precedence.
  try {
    const envText = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
    }
  } catch {
    // No .env is fine. The app has a local demo fallback.
  }
}

function normaliseOrderId(value = "") {
  const digits = String(value).toUpperCase().replace(/[^0-9]/g, "");
  return digits.length === 4 ? `NS-${digits}` : null;
}

function extractOrderId(text = "") {
  const match = String(text).match(orderIdPattern);
  return match ? normaliseOrderId(match[0]) : null;
}

function extractOrderIds(text = "") {
  return [...new Set([...String(text).matchAll(new RegExp(orderIdPattern, "gi"))]
    .map((match) => normaliseOrderId(match[0]))
    .filter(Boolean))];
}

function lookupOrder(orderId) {
  const order = orders.find((candidate) => candidate.id === normaliseOrderId(orderId));
  if (!order) return { found: false, order_id: normaliseOrderId(orderId) || String(orderId) };

  return {
    found: true,
    order_id: order.id,
    customer: order.customer,
    items: order.items,
    status: order.status,
    total: order.total,
    shipping_method: order.shipping,
    tracking: order.tracking || null,
    delivered_at: order.deliveredAt || null,
    refunded_at: order.refundedAt || null,
    cancellation_eligible: order.status === "processing"
  };
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .slice(-10)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 2000) }));
}

function detectBilling(message) {
  return billingPattern.test(message);
}

// Evaluates the model boundary, records the allowed call, dispatches, then audits the outcome.
async function governedModelCall(session, request, governedTexts) {
  await session.beforeModel(
    {
      provider: "openai",
      name: request.model,
      inputTokens: estimateTokens(request.instructions) + estimateTokens(request.input)
    },
    governedTexts
  );

  const startedAt = Date.now();
  let response;
  try {
    response = await openai.responses.create(request);
  } catch (error) {
    try {
      await session.afterModel(
        { provider: "openai", name: request.model },
        "failed",
        Date.now() - startedAt,
        classifyFailure(error)
      );
    } catch { /* The provider failure is the error worth surfacing. */ }
    throw error;
  }

  const usage = response.usage || {};
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const costUsd = estimateCostUsd(request.model, inputTokens, outputTokens);

  await session.afterModel(
    {
      provider: "openai",
      name: request.model,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
      ...(costUsd === undefined ? {} : { costUsd })
    },
    "completed",
    Date.now() - startedAt,
    undefined,
    response.output_text
  );

  return response;
}

// Evaluates the tool boundary, records the allowed call, resolves it, then audits the result.
async function governedOrderLookup(session, rawOrderId, suppliedOrderIds) {
  const requestedOrderId = normaliseOrderId(rawOrderId);
  const toolArguments = { order_id: requestedOrderId || String(rawOrderId ?? "") };

  await session.beforeTool(ORDER_LOOKUP_TOOL_DID, toolArguments);

  const startedAt = Date.now();
  let payload;
  try {
    payload = suppliedOrderIds.includes(requestedOrderId)
      ? lookupOrder(rawOrderId)
      : { found: false, error: "This order ID was not supplied by the customer. Ask them to provide it." };
  } catch (error) {
    try {
      await session.afterTool(ORDER_LOOKUP_TOOL_DID, toolArguments, "failed", Date.now() - startedAt, classifyFailure(error));
    } catch { /* The lookup failure is the error worth surfacing. */ }
    throw error;
  }

  const serialised = JSON.stringify(payload);
  await session.afterTool(ORDER_LOOKUP_TOOL_DID, toolArguments, "completed", Date.now() - startedAt, undefined, serialised);
  return serialised;
}

async function runAgentTurn({ session, agent, handoff, message, conversation }) {
  const orderId = extractOrderId(message);
  const suppliedOrderIds = [...new Set([
    ...conversation.filter((item) => item.role === "user").flatMap((item) => extractOrderIds(item.content)),
    ...extractOrderIds(message)
  ])];

  // A missing order is resolved before OpenAI sees the prompt, so it can never hallucinate its details.
  const missingOrderId = suppliedOrderIds.find((id) => !lookupOrder(id).found);
  if (missingOrderId) {
    return {
      agent,
      handoff,
      reply: `I couldn’t find order ${missingOrderId}. Please check the ID and try again.`,
      source: "local"
    };
  }

  if (!openai) {
    return { agent, handoff, reply: localReply(message, orderId, agent), source: "demo" };
  }

  const input = [...conversation, { role: "user", content: message }];
  const instructions = agent === "billing" ? billingInstructions : supportInstructions;
  const requestBase = { model: MODEL, instructions, tools: [orderLookupTool], max_output_tokens: 180, store: false };

  try {
    let response = await governedModelCall(
      session,
      { ...requestBase, input, tool_choice: orderId ? { type: "function", name: "lookup_order" } : "auto" },
      [{ source: "user_message", content: message }]
    );

    for (let turns = 0; turns < 3; turns += 1) {
      const toolCalls = response.output.filter((item) => item.type === "function_call");
      if (!toolCalls.length) break;

      const toolOutputs = [];
      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.arguments); } catch { /* Function schema prevents this in normal use. */ }
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: await governedOrderLookup(session, args.order_id, suppliedOrderIds)
        });
      }

      response = await governedModelCall(
        session,
        { ...requestBase, input: [...input, ...response.output, ...toolOutputs], tool_choice: "auto" },
        toolOutputs.map((item) => ({ source: "tool_result", content: item.output }))
      );
    }

    const reply = response.output_text?.trim();
    if (!reply) throw new Error("The model did not return text.");
    return { agent, handoff, reply, source: "openai" };
  } catch (error) {
    // A governance denial is not a provider outage; it must not be reported as one.
    if (error instanceof GovernanceDeniedError) throw error;
    console.error("OpenAI request failed:", error.message);
    return {
      agent,
      handoff,
      reply: "I’m having trouble reaching the assistant right now. Please try again in a moment.",
      source: "error"
    };
  }
}

async function askAgent({ message, history, activeAgent }) {
  const billing = activeAgent === "billing" || detectBilling(message);
  const agent = billing ? "billing" : "support";
  const handoff = agent === "billing" && activeAgent !== "billing";
  const conversation = cleanHistory(history);

  // One conversation maps to one governance session so usage counters accumulate across turns.
  const firstUserMessage = conversation.find((item) => item.role === "user")?.content || message;
  const session = new GovernedSession(handoff ? "support" : agent, deriveSessionId(firstUserMessage));
  const startedAt = Date.now();

  try {
    await session.agentStart(message);
    // The router changes the acting agent itself, so the transfer is a governed handoff.
    if (handoff) await session.transferTo("billing");

    const result = await runAgentTurn({ session, agent, handoff, message, conversation });
    await session.agentEnd("completed", Date.now() - startedAt);
    return result;
  } catch (error) {
    if (error instanceof GovernanceDeniedError) {
      await session.agentEnd("failed", Date.now() - startedAt, `GovernanceDenied at ${error.decision?.checkpoint || "unknown"}`);
      return {
        agent,
        handoff,
        reply: "I can’t help with that request. Please ask about an order, shipping, returns, cancellations, or billing.",
        source: "blocked"
      };
    }
    await session.agentEnd("failed", Date.now() - startedAt, classifyFailure(error));
    throw error;
  }
}

function localReply(message, orderId, agent) {
  if (orderId) {
    const order = lookupOrder(orderId);
    const statusText = order.status === "processing"
      ? "It’s being prepared and can still be cancelled."
      : order.status === "shipped"
        ? `It’s on its way${order.tracking ? ` (tracking ${order.tracking})` : ""}.`
        : order.status === "delivered"
          ? `It was delivered on ${order.delivered_at}.`
          : `It was refunded on ${order.refunded_at}.`;
    return `Order ${order.order_id} is ${order.status}. ${statusText}`;
  }
  if (agent === "billing") return "You’re speaking with Sage from billing. Please share your order ID so I can help with the billing question.";
  if (/return/i.test(message)) return "Returns are accepted within 30 days of delivery. Refunds go to the original payment method in 5–7 business days.";
  if (/express|standard|shipping|delivery/i.test(message)) return "Standard shipping takes 3–5 business days, and express shipping takes 1–2 business days.";
  if (/cancel/i.test(message)) return "Orders can be cancelled only while their status is processing. Share your order ID and I’ll check it.";
  return "I can help with shipping, returns, cancellations, or an order status. What would you like to know?";
}

app.use(express.json({ limit: "100kb" }));

app.get("/api/orders", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ orders });
});

app.get("/api/health", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ ok: true, aiEnabled: Boolean(openai), model: openai ? MODEL : null });
});

app.post("/api/chat", async (request, response) => {
  const message = typeof request.body?.message === "string" ? request.body.message.trim().slice(0, 2000) : "";
  if (!message) return response.status(400).json({ error: "A message is required." });

  try {
    const result = await askAgent({ message, history: request.body.history, activeAgent: request.body.activeAgent });
    return response.set("Cache-Control", "no-store").json(result);
  } catch (error) {
    return response.status(500).json({ error: error.message || "Could not process your message." });
  }
});

if (process.env.NODE_ENV === "production") {
  const distDirectory = join(process.cwd(), "dist");
  app.use(express.static(distDirectory));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) return next();
    return response.sendFile(join(distDirectory, "index.html"));
  });
}

// Governance is initialised before the server accepts traffic; a failure exits instead of serving ungoverned.
await initGovernance();

app.listen(PORT, () => {
  console.log(`Northstar Express API is running at http://localhost:${PORT}`);
  console.log(openai ? `OpenAI support and billing agents are enabled (${MODEL}).` : "Demo fallback is enabled. Set OPENAI_API_KEY to enable OpenAI agents.");
});
