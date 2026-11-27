# Agents plan: Northstar Support Portal

The app keeps its two chat assistants, Nova and Sage, as the code runs them today. The new leave days page uses no AI, and leave data and sign-in data must never go to OpenAI.

## Agent decision
The two existing assistants set the rung, and the change adds no AI.

Rung: 4, two agents with a transfer that app code starts. Risk tier 2, because the assistants handle personal data and there are two of them.

Why not the rung below: functional requirements (FR) FR-26 to FR-30 give billing topics their own specialist, transfer notice and label. Both assistants share one tool and one model, so the split rests on that billing branch.

Non-AI option rejected: prepared replies alone, which the app uses without an OpenAI key, do not answer follow-up questions (FR-09, FR-32).

The leave days page is rung 0: fixed code returns the number Workday records. No assistant gets a leave tool, and chat still needs no sign-in, as technical requirements (TR) TR-27 and TR-32 require.

Today's code carries these risks:

- Anyone who types an order identifier (ID), without sign-in, hands the assistant that customer's name, items and total (Q9 in functional-requirements.md).
- The Portal service checks the new message and order records for instruction overrides, but not earlier messages. A refused message therefore reaches OpenAI with the next one (Q44).
- The browser supplies the earlier messages and the active assistant, so a caller can forge assistant replies or start at Sage.
- `ZBRAIN_GOVERNANCE=false` switches off the override, hidden marker, usage and size checks.
- The override check relies on company-wide rules from the ZBrain Governance service. The solution's own policy file holds no such rule.

## Nova
Nova answers store support questions and reads one order record at a time through its only tool.

Goal: Answers a customer's questions on orders, shipping, returns and cancellations.

Trigger: A customer sends a message, on their own behalf and without sign-in. App code picks Nova unless the chat is with Sage or the message raises a billing topic.

Inputs: Instructions with store rules, the new message, up to 10 earlier messages and order records. Untrusted: the new message, and the earlier messages and active assistant field that the browser sends.

Model: `gpt-4.1-mini` unless `OPENAI_MODEL` names another, because that is today's default. Framework: the OpenAI software development kit (SDK) for Node.js, Responses API, with the app's own tool loop.

Tools:
| Tool | Type | Read or write | Reversible | Risk | Runs as |
| --- | --- | --- | --- | --- | --- |
| `lookup_order` | Data | Read | Yes, nothing changes | Low, as the solution manifest rates it | The Portal service, with no customer sign-in |

The tool takes one `order_id` text value under a strict schema. The code forces this tool on the first model call when the new message holds an order ID. The tool loop runs the order lookup for every function call, whatever name the model returns.

Data: reads sample orders; writes no order data. Personal data: what the customer types, plus the order's customer name, items, status, total, shipping details and dates. OpenAI receives both, in requests that set `store: false`.

Never does:

- Changes, cancels or refunds an order. Enforced in: the tool, which only reads.
- Gets the record of an order whose ID no customer message holds. Enforced in: the tool code, which trusts the customer messages the browser sends.
- Describes an unknown order. Enforced in: the Portal service, which answers before any model call (TR-10).
- Shows a hidden marker. Enforced in: the governance check on each model result, when governance is on and markers are set.
- Receives leave data or sign-in data. Enforced in: the chat route, which must build requests only from instructions, chat fields and `lookup_order` results (TR-32).

The instructions alone ask Nova to keep three short sentences, leave billing to Sage and invent no order details. No code enforces those three.

Limits: 3 tool rounds and 4 model calls per turn, 180 output tokens per call, 2000 characters per message and 10 earlier messages. With governance on, each chat count allows 10 Nova model calls, 10 order lookups shared with Sage and 12000 estimated tokens per request. The code sets no cost limit, timeout or retry count. For the last two, the OpenAI Node.js library's documented defaults apply: 10 minutes and 2 retries.

Exit and failure: a turn ends when the model returns text, and these rules cover the other endings.

- On an OpenAI error, or no text after 3 tool rounds, the customer gets the try again reply (FR-33).
- On a governance denial or limit, the customer gets the refusal message (FR-34 to FR-38).
- On any other error, the Portal service returns HTTP 500 and the chat shows the error text (FR-15).
- To stop Nova and Sage, the app's operator removes `OPENAI_API_KEY` and restarts. Customers then get prepared replies.
- No switch stops one assistant or cancels a running turn, and the governance kill switch address is a placeholder.
- A restart mid-turn loses the turn with nothing to undo. It also resets orders and chat counts, and signs out leave days sessions (TR-40).

Human control: level 1, the nearest on the scale, although no alert exists today (Q45). Approval points: none, because the one tool only reads. Escalation: none to a person; billing topics go to Sage.

Owner: `northstar-support`, as the solution manifest names it.

## Sage
Sage answers billing questions with the same tool and model as Nova, under its own instructions.

Goal: Answers a customer's questions on refunds, charges, payments and invoices.

Trigger: A customer's message raises a billing topic, or the browser reports that the chat is already with Sage. Sage acts for that customer, without sign-in.

Inputs: Instructions with store rules, the new message, up to 10 earlier messages, including Nova's replies, and order records. Untrusted: the new message, the earlier messages and the active assistant field.

Model: `gpt-4.1-mini` unless `OPENAI_MODEL` names another, because both assistants share one setting. Framework: the OpenAI SDK for Node.js, Responses API, with the same tool loop.

Tools:
| Tool | Type | Read or write | Reversible | Risk | Runs as |
| --- | --- | --- | --- | --- | --- |
| `lookup_order` | Data | Read | Yes, nothing changes | Low, as the solution manifest rates it | The Portal service, with no customer sign-in |

The solution manifest rates Sage itself medium risk and Nova low risk.

Data: the same reads and personal data as Nova, with no writes to order data.

Never does: the five actions in Nova's list, each enforced in the same place. The instructions alone tell Sage to invent no payment details and to stay under three short sentences.

Limits: 3 tool rounds and 4 model calls per turn, 180 output tokens per call, 2000 characters per message and 10 earlier messages. With governance on, each chat count allows 10 Sage model calls, 10 order lookups shared with Nova and 12000 estimated tokens per request. The OpenAI library defaults apply as for Nova: a 10 minute timeout and 2 retries, with no cost limit.

Exit and failure: a turn ends and fails as Nova's does.

- The app's operator stops Sage only together with Nova, by removing `OPENAI_API_KEY` and restarting.
- A new chat or a reload returns the customer to Nova (FR-10, FR-11).

Human control: level 1, as for Nova. Approval points: none, because the one tool only reads. Escalation: none; Sage's instructions name a billing teammate whom the app cannot reach (Q13 in functional-requirements.md).

Owner: `northstar-support`, as the solution manifest names it.

## Topology
App code, not a model, picks the assistant on every turn, and control moves one way.

- Nova => Sage (handoff): app code starts it when the new message raises a billing topic. It passes the message and up to 10 earlier messages.
- Sage => Nova: no transfer exists. Sage keeps every later message until a new chat or a reload.

With governance on, the Portal service records the turn start under Nova and checks the transfer before Sage runs. A refused billing message still moves the chat to Sage. Nova's instructions tell it to announce a transfer for billing matters that reach it, but that reply moves nothing. Q12 in functional-requirements.md covers the words that miss the billing branch.

## Observability
Today the app relies on governance records and console lines, and the leave days page makes no AI call to record.

Traced: no trace per run exists. With governance on, ZBrain Governance gets a record per checked step, grouped by chat count. Records name the assistant and step, and add model, tokens, estimated cost, duration or status where they apply. After an OpenAI failure, the model result reads failed but the turn end reads completed.

Content stored: the app stores no prompts or replies, and the browser holds the chat until reload. Governance records hold no message text. The console logs governance decision fields and OpenAI's error message. With governance off, no governance records exist.

Action log: governance records show each model-requested lookup but not which order ID it read. No source names a person who reviews them (Q45).

Evals: `npm test` runs the governance rule checks without a live model. No example set of customer questions or pass mark exists (Q45). One check expects a refusal on the ninth lookup, while the policy allows 10 (Q11 in functional-requirements.md).

Alerts: none today, with no threshold or receiver (Q45).

## Open questions
These rows hold the two points on the assistants that no source settles.

| Id | Question | Changes | Who answers | Answer | Date |
| --- | --- | --- | --- | --- | --- |
| Q44 | A message that the safety rules refuse stays in the chat, and goes to the AI unchecked with the next message. Must this change? | Agent decision, Nova and Sage inputs, FR-34 | AI Developer | Open | 27 Nov 2026 |
| Q45 | After release, must anyone watch or test the assistants beyond today's records and rule checks? | Observability: Action log, Evals, Alerts | AI Developer | Open | 27 Nov 2026 |
