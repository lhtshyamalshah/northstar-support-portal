# Architecture: Northstar Support Portal

The app has two parts: the Web app in the browser, and the Portal service, which serves it and the API. The Portal service runs as one Docker container in the customer's AWS account and finds orders by identifier (ID). The leave days page adds one Web app path and one endpoint, using Microsoft Entra ID and Workday. The design keeps the existing JavaScript, React, Express and governance code.

## Stack and templates
The app keeps its own stack and starts from no new template.

| Part | Choice | Why | Rejected | Cost |
| --- | --- | --- | --- | --- |
| Web app | Existing React 19 and Vite 7 code, in JavaScript | It already serves the support page and order desk (FR-01, FR-41). | The vite-react-ts template: it means rewriting working pages in TypeScript. | No type checks. |
| Portal service | Existing Express 5 service on Node.js 22 | The design request asks for one service. | A separate leave service: it adds a second deployment. | Leave days and chat share one process. |
| Leave days page | A `/leave` path in the Web app, chosen as `/admin` is | The request asks for one page (FR-47). | A routing library: one more path does not need it. | The code matches paths by hand. |
| Model access | Existing OpenAI software development kit (SDK), Responses API | Nova and Sage already run on it (FR-04). | The OpenAI Agents SDK: it means rewriting working assistants. | The app maintains its own tool loop. |
| AI governance | Existing ZBrain Governance SDK in `package/` | It carries the governance rules (FR-34 to FR-40). | Removing it: those requirements lose their cover. | Startup depends on the ZBrain Governance service. |
| Data storage | Process memory, no database | Sample orders reset on restart (FR-48), and Workday holds leave (FR-52). | A database: no requirement keeps data across restarts. | Each running copy has its own orders and chat counts. |
| Company sign-in | Microsoft Entra ID | The requester named it (FR-51). | Accounts inside the app: FR-51 requires the company sign-in. | The company must register the app. Q24 decides the library. |
| HR system | Workday, read on each request | The requester named it, and the page shows today's recorded number (FR-52). | A copy of leave data in the app: it goes out of date. | The page depends on Workday being reachable. |

## Workspace layout
The app stays at the repository root, with one new server module and no new folder.

```text
./             server.mjs, governance.mjs, new leave.mjs for sign-in and Workday, config files
src/           Web app code, gains the leave days page
public/        Stylesheet
governance/    Solution manifest and policy, unchanged
package/       ZBrain Governance SDK, unchanged
plugins/       Preview inspector for Vite
test/          Node.js tests, gains leave days tests
.zbrain/       Smoke test and deploy scripts
zbrain-docs/   Planning documents
```

## Environment variables
The platform supplies these at run time, and Q24 and Q26 add the credential variables.

### Web app
| Name | Purpose | Secret | Example |
| --- | --- | --- | --- |
| `PORT` | Port of the Vite development server | No | 5173 |
| `BACKEND_1_URL` | Portal service address for the development proxy | No | none |

### Portal service
| Name | Purpose | Secret | Example |
| --- | --- | --- | --- |
| `PORT` | Port the service listens on | No | 3000 |
| `NODE_ENV` | `production` also serves the built Web app | No | production |
| `APP_PORT` | Host port that Docker Compose publishes | No | 3000 |
| `OPENAI_API_KEY` | Connects the AI service | Yes | none |
| `OPENAI_MODEL` | Model for Nova and Sage | No | gpt-4.1-mini |
| `ZBRAIN_GOVERNANCE` | `false` switches governance off | No | true |
| `ZBRAIN_GOVERNANCE_BASE_URL` | Address of the ZBrain Governance service | No | none |
| `ZBRAIN_GOVERNANCE_API_KEY` | Key for the ZBrain Governance service | Yes | none |
| `ZBRAIN_GOVERNANCE_SOLUTION_ID` | Identifies the solution | No | none |
| `ZBRAIN_GOVERNANCE_DEPLOYMENT_ID` | Identifies the deployment | No | none |
| `ZBRAIN_GOVERNANCE_CANARY_TOKEN` | Hidden markers placed in assistant instructions | Yes | none |
| `CRON_TIME` | Schedule for refreshing governance rules | No | `0 */6 * * *` |
| `ENTRA_TENANT_ID` | New: the company's Microsoft Entra ID tenant | No | none |
| `ENTRA_CLIENT_ID` | New: the app's registration in that tenant | No | none |
| `WORKDAY_BASE_URL` | New: address of the Workday API | No | none |
| `WORKDAY_TENANT` | New: the company's Workday tenant | No | none |

## Components
Two components run the app, and in development Vite serves the Web app and passes `/api` calls on.

| Component | Type and technology | Runs on | Owns data | FR ids |
| --- | --- | --- | --- | --- |
| Web app | Single-page app: React, Vite | The browser, with files served from Amazon EC2 or Amazon ECS | Chat history, in browser memory | FR-01 to FR-08, FR-10, FR-11, FR-14, FR-15, FR-24, FR-25, FR-27, FR-29, FR-41, FR-43 to FR-47, FR-49, FR-53 |
| Portal service | Service: Node.js, Express | Amazon EC2 or Amazon ECS | Sample orders and chat counts, in process memory | FR-04, FR-07 to FR-09, FR-12, FR-13, FR-16 to FR-23, FR-26, FR-28, FR-30 to FR-40, FR-42, FR-47, FR-48, FR-50 to FR-52 |

## Data flow
These flows cover the journeys that call an outside system.

### Customer: check on an order
1. Web app sends the message, history and active assistant to the Portal service.
2. Portal service checks the turn against governance rules and sends audit records to the ZBrain Governance service.
3. Portal service answers an unknown order identifier itself.
4. Portal service sends the instructions and conversation to OpenAI, which asks for `lookup_order`.
5. Portal service reads the order from memory and returns it to OpenAI.
6. Portal service returns OpenAI's reply, and the Web app shows it.

### Customer: learn a store rule
1. Web app shows the store rule notes and the order details notice.
2. Web app sends the question to the Portal service.
3. Portal service checks it and sends it to OpenAI with Nova's instructions.
4. Portal service returns the reply, or a prepared reply when no OpenAI key is set.

### Customer: get billing help
1. Web app sends the message to the Portal service.
2. Portal service picks Sage from the billing topic or the active assistant.
3. Portal service checks the transfer against governance rules.
4. Portal service sends the conversation to OpenAI with Sage's instructions.
5. Web app shows the transfer notice, the specialist label and the reply.

### Employee: see leave days left
1. Web app opens `/leave` and asks the Portal service for the leave days.
2. Employee signs in through Microsoft Entra ID, and the Web app or Portal service handles it (Q24).
3. Portal service validates the sign-in and takes the employee's identity from it.
4. Portal service finds the employee's Workday record, matched as Q25 settles.
5. Portal service reads today's annual leave balance from Workday (Q26, Q27, Q28).
6. Portal service returns the number unchanged, and the Web app shows it.

Three questions in functional-requirements.md are Open, so this design gives their cases no behaviour. They are Q6 (no leave number), Q19 (sign-in or Workday unavailable) and Q23 (a person who cannot sign in).

## Integrations
The app calls these outside systems.

| System | What the app does with it | Direction | Auth | FR ids |
| --- | --- | --- | --- | --- |
| OpenAI | Gets Nova's and Sage's replies through the Responses API | Out from the Portal service | API key | FR-04, FR-09, FR-33 |
| ZBrain Governance service | Registers the app, gets policy rules, sends audit and violation records | Out from the Portal service | Bearer API key | FR-34, FR-39, FR-40 |
| Microsoft Entra ID | Signs employees in and says who is looking | Browser redirect and Portal service check | Company account for employees; app credential per Q24 | FR-51 |
| Workday | Reads one employee's annual leave balance as of today | Out from the Portal service, read only | Open: Q26 | FR-47, FR-52 |
| Google Fonts | Loads the page fonts, as index.html does today | Out from the Web app | None | Whole app |

## API contract
### Portal service
Callers send no sign-in, except on `GET /api/leave-days`, which needs a company sign-in. In production, other paths outside `/api/` return the Web app. Q24 decides the sign-in routes, so this table lists none.

| Method and path | Caller | Purpose | Request | Responses | FR ids |
| --- | --- | --- | --- | --- | --- |
| `GET /api/health` | Deploy smoke script | Report running state | None | 200 `ok`, `aiEnabled`, `model` | FR-50 |
| `GET /api/orders` | Web app | List sample orders | None | 200 `orders` | FR-41, FR-42 |
| `POST /api/chat` | Web app | Answer a chat message | `message`, `history`, `activeAgent` | 200 `agent`, `handoff`, `reply`, `source`; 400 blank message; 500 `error` | FR-04, FR-07, FR-15, FR-26 |
| `GET /api/leave-days` | Web app | Return the signed-in employee's leave days left | No fields: the sign-in names the employee | 200 `daysLeft`; 401 no valid company sign-in | FR-47, FR-51, FR-52 |

Q6, Q19 and Q23 in functional-requirements.md decide the other outcomes of `GET /api/leave-days`.

## AI components
The two existing assistants stay as they are, and the leave days page uses no AI.

| Name | Rung | Model | What it does | FR ids |
| --- | --- | --- | --- | --- |
| Nova | 4 | `gpt-4.1-mini`, unless `OPENAI_MODEL` names another | Answers store support questions with the `lookup_order` tool | FR-09, FR-12, FR-16, FR-18, FR-20, FR-21, FR-22 |
| Sage | 4 | `gpt-4.1-mini`, unless `OPENAI_MODEL` names another | Answers billing questions with the `lookup_order` tool | FR-13, FR-23, FR-26, FR-28, FR-30 |

## Technical requirements
Each technical requirement (TR) covers today's app or the leave days page. Where these questions in functional-requirements.md are Open, the rows keep today's behaviour:

- Q8: TR-17 and TR-18.
- Q9 and Q10: TR-01, TR-09 and TR-10.
- Q11: TR-14.
- Q12: TR-06.
- Q13 and Q14: TR-08, TR-11 and TR-13.
- Q15: TR-12.

| TR id | Kind | Requirement | FR ids covered |
| --- | --- | --- | --- |
| TR-01 | Feature | The Web app must show Nova's greeting and three suggested questions, and send a chosen one as a message. | FR-01, FR-02, FR-03 |
| TR-02 | Feature | The Web app must show messages, replies and a typing sign, and disable the message box while waiting. | FR-04, FR-05, FR-06 |
| TR-03 | Feature | The Web app and Portal service must drop blank messages and limit each message to 2000 characters. | FR-07, FR-08 |
| TR-04 | Feature | The Web app must hold the conversation only in browser memory, and clear it on new chat or reload. | FR-10, FR-11 |
| TR-05 | Feature | The Portal service must send OpenAI at most the 10 latest earlier messages with each new message. | FR-09 |
| TR-06 | Feature | The Portal service must route a billing topic to Sage, and every later message with it. | FR-26, FR-28 |
| TR-07 | Feature | The Web app must show the transfer notice and specialist label from the reply's `handoff` and `agent` fields. | FR-27, FR-29 |
| TR-08 | Feature | Nova's and Sage's instructions must carry the store rules, answer length limits and order identifier requests. | FR-12, FR-13, FR-18, FR-20, FR-21, FR-22, FR-23, FR-30 |
| TR-09 | Feature | The Portal service must accept the FR-17 identifier forms, and give assistants records only for customer-typed order identifiers. | FR-16, FR-17 |
| TR-10 | Feature | The Portal service must answer an unknown order identifier itself, without calling OpenAI. | FR-19 |
| TR-11 | Feature | Without an OpenAI key, the Portal service must answer from order records and prepared replies. | FR-21, FR-22, FR-31, FR-32 |
| TR-12 | Feature | The Portal service must turn an OpenAI failure into a retry reply, and the Web app must show other errors. | FR-15, FR-33 |
| TR-13 | Feature | The Web app must show the order details notice, the three store rule notes and the Support center link. | FR-14, FR-24, FR-25 |
| TR-14 | Feature | While governance is on, the Portal service must check each agent, model, tool and handoff step, and refuse denials. | FR-34, FR-35, FR-36, FR-37, FR-38 |
| TR-15 | Feature | While governance is on, the Portal service must send an audit record per checked step and log only decision fields. | FR-39 |
| TR-16 | Feature | While governance is on, the Portal service must exit at startup when a required governance setting is missing. | FR-40 |
| TR-17 | Feature | The Portal service must serve orders without sign-in, and the Web app must show the list, legend, loading text and load error. | FR-41, FR-42, FR-43, FR-44, FR-45 |
| TR-18 | Feature | The Web app must link the support page and the order desk to each other. | FR-46 |
| TR-19 | Feature | The Portal service must hold the ten sample orders only in memory. | FR-48 |
| TR-20 | Feature | Every page, including leave days, must follow the stylesheet's layout for screens 650 pixels wide or narrower. | FR-49 |
| TR-21 | Feature | `GET /api/health` must report that the app runs, whether the AI service is connected, and the model. | FR-50 |
| TR-22 | Feature | The Web app must show every visitor of the support page a link to `/leave`. | FR-53 |
| TR-23 | Feature | The Portal service must return leave data only for a valid sign-in from the company's Microsoft Entra ID tenant. | FR-47, FR-51 |
| TR-24 | Feature | The Portal service must take the employee's identity only from that sign-in, never from request input. | FR-47, FR-51 |
| TR-25 | Feature | The Portal service must read today's annual leave balance from Workday and return the number unchanged. | FR-47, FR-52 |
| TR-26 | Feature | The leave days page must offer nothing besides the leave days left. | FR-47 |
| TR-27 | Feature | The Portal service must require the company sign-in for leave days only, leaving chat and orders open. | FR-42, FR-51 |
| TR-28 | Quality | The Portal service must read Workday on every leave days request and never store the number. | FR-52 |
| TR-29 | Quality | Responses carrying health, orders, chat replies or leave days must send `Cache-Control: no-store`. | FR-04, FR-41, FR-47, FR-50 |
| TR-30 | Quality | Each turn must allow at most 3 tool rounds, and each model call 180 output tokens, with `store: false`. | FR-04 |
| TR-31 | Quality | The app must never write sign-in tokens, Workday credentials or leave data to its logs. | Whole app |
| TR-32 | Constraint | The app must never send leave data or sign-in data to OpenAI. | FR-47 |
| TR-33 | Constraint | One service must serve both the API and the built Web app (design request, 27 Nov 2026). | Whole app |
| TR-34 | Constraint | The Portal service must run in the customer's AWS account on Amazon EC2 or Amazon ECS (ZBrain platform). | Whole app |
| TR-35 | Constraint | New settings must come from the environment and appear in `.env.example`, `integrations-config.json` and `docker-compose.yml`. | Whole app |
| TR-36 | Constraint | The Dockerfile must copy every new server module into the runtime image. | Whole app |

## Non-goals
The design leaves these out on purpose.

- A second service: the design request, 27 Nov 2026, asks for one.
- A stored copy of leave numbers: Workday holds them, and the page shows today's record (FR-52).
- Showing leave days to anyone but that employee: excluded by Q2 in functional-requirements.md.
- Leave other than annual leave: excluded by Q4 in functional-requirements.md.
- Other features on the leave days page: excluded by Q5 in functional-requirements.md.

## Open questions
No source settles these design points.

| Id | Question | Changes | Who answers | Answer | Date |
| --- | --- | --- | --- | --- | --- |
| Q24 | Where does the app handle the company sign-in? | Stack and templates, API contract, TR-23 | AI Developer | Open | 27 Nov 2026 |
| Q25 | How does the app match a signed-in person to their Workday record? | Data flow, TR-24, TR-25 | AI Developer | Open | 27 Nov 2026 |
| Q26 | How is the app allowed to read leave balances from Workday? | Integrations, Environment variables, TR-25 | AI Developer | Open | 27 Nov 2026 |
| Q27 | How does the app know which Workday balance is annual leave? | Environment variables, TR-25 | AI Developer | Open | 27 Nov 2026 |
| Q28 | Which time zone's date counts as today for the balance? | TR-25, FR-52 | AI Developer | Open | 27 Nov 2026 |
| Q29 | How long does an employee stay signed in to the leave days page? | TR-23 | AI Developer | Open | 27 Nov 2026 |
| Q30 | Must the app start when the sign-in or Workday settings are missing? | TR-23, TR-25 | AI Developer | Open | 27 Nov 2026 |
| Q31 | Must the app record who looked up their leave days? | Technical requirements, FR-47 | AI Developer | Open | 27 Nov 2026 |
| Q32 | How soon must the leave days page answer, and for how many employees? | Technical requirements | AI Developer | Open | 27 Nov 2026 |
