# Functional requirements: Northstar Support Portal

## Purpose
The app is a customer-support portal for an online store, with an open order desk. This version adds one page where an employee sees their annual leave days left, and makes a new chat ready without old replies.

## Users
The app serves three user types. Today it has no sign-in, and this version adds company single sign-on for the leave page.

| User type | What they do in the app |
| --- | --- |
| Customer | Asks Nova or Sage about orders, shipping, returns, cancellations and billing. |
| Order desk visitor | Reads the list of orders on the order desk, which anyone is able to open. |
| Employee | Signs in with company single sign-on, which opens the leave page to everyone who has it, and sees their own leave balance. |

## Terms
These words have one meaning each in the requirements.

| Term | Meaning |
| --- | --- |
| Support page | The page with the chat and the store policies. |
| Chat | The messages between a customer and an assistant, until the customer starts a new one. |
| Assistant | Nova or Sage. |
| Nova | The assistant for general store support. |
| Sage | The billing specialist assistant. |
| Billing words | Words that move a chat to Sage: refund, refunded, refunding, invoice, billing. Also: double charge, duplicate charge, charged twice. Also: payment issue, payment problem, card charge, card payment. Only these exact forms count, not their plurals. |
| Order identifier (ID) | The code of one order, called the order ID: the Northstar prefix (NS) and 4 digits, like NS-1001. |
| Order status | One of processing, shipped, delivered or refunded. |
| Order desk | The page that lists the orders, labelled as an internal view. |
| Demo mode | The way the app replies when no AI key is set up: with fixed replies. |
| Governance rules | ZBrain Governance limits on the chat. They apply unless the app's setup switches them off. |
| Refusal reply | The reply that declines a request and asks about an order, shipping, returns, cancellations or billing. |
| Hidden marker | A secret text placed in the assistants' instructions to detect leaks. |
| Conversation | What the governance rules count against. It is named by the oldest customer message the assistant is given, at first the opening message. |
| Leave page | The new page where an employee sees their leave balance. |
| Leave balance | One total of annual leave days left. Approved leave not yet taken, and requests waiting for approval, count as used. |
| Company single sign-on | The company's sign-in through Microsoft Entra ID, which tells the app which employee is looking at the leave page. |
| Workday | The company's existing HR system, where leave balances come from and are kept correct. |

## Requirements
The requirements describe the app as it behaves today, plus two pieces of new work. One is the leave page. The other is FR-58 to FR-60, because today a new chat still waits for an old reply and shows it.

### Support chat
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-01 | When a customer opens the support page, the app must start a chat with a greeting from Nova. | Nova offers help with an order, shipping, returns or cancellations. | S3 |
| FR-02 | While a customer has sent no message, the app must offer 3 ready-made questions. | The customer sees Track an order, Return policy and Shipping times, and choosing one sends its question. | S3 |
| FR-03 | When a customer sends a message, the app must show the assistant's reply in the chat. | A customer asks about the return policy and sees a reply under the message. | S2, S3 |
| FR-04 | While a chat waits for a reply to its own message, the app must show that the assistant is typing. | Moving dots show until the reply appears. | S3, Q29 |
| FR-05 | While a chat waits for a reply to its own message, the app must block a second message. | While the dots show, the message box takes no typing. | S3, Q29 |
| FR-06 | The app must limit each customer message to 2000 characters. | The message box stops taking text at 2000 characters. | S2, S3 |
| FR-07 | When a customer chooses to start a new chat, the app must replace the chat with a new one with Nova. | After a chat with Sage, New chat shows only Nova's greeting. | S3 |
| FR-58 | When a customer starts a new chat while a reply is on its way, the app must drop that reply. | A customer asks a question, starts a new chat before the answer shows, and never sees that answer there. | Q28 |
| FR-59 | When a customer starts a new chat while a reply is on its way, the app must show the new chat without typing dots. | A customer starts a new chat while the dots show, and the new chat has no dots. | Q29 |
| FR-60 | When a customer starts a new chat while a reply is on its way, the app must accept a message there at once. | A customer starts a new chat while the dots show, and is able to type and send a new question there. | Q29 |
| FR-08 | If the app fails to process a message, then the app must show an error message in the chat. | The chat shows the error text, or a line saying something went wrong. | S2, S3 |
| FR-09 | The app must keep each assistant reply to 3 sentences or fewer. | A reply about returns holds no more than 3 sentences. | S2 |
| FR-10 | When a customer sends a message, the app must give the assistant that message and no more than 10 earlier ones. | In a long chat, an order ID typed more than 10 messages earlier no longer counts. | S2 |
| FR-11 | The app must show a privacy note with the chat. | The note says order details are only used to answer this conversation. | S3 |

### Order questions
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-12 | When a customer's message holds a 4-digit number, with or without NS, the app must treat it as an order ID. | A customer asks about order 1001 and gets the answer for NS-1001. A customer who types the year 2026 is told that NS-2026 was not found. | S2, Q12 |
| FR-13 | When a customer gives a known order ID, the app must answer from that order's details, without asking the customer to sign in. | A customer who has not signed in asks about NS-1002 and learns that it has shipped. With demo mode off, a customer who asks the name and total on NS-1001 is able to get them. | S2, Q6 |
| FR-14 | While demo mode is off, when a customer asks about one order without an order ID, the app must ask for it. | A customer asks where their order is, and Nova asks for the order ID. | S2 |
| FR-15 | If a customer gives an order ID that matches no order, then the app must reply that it did not find that order. | A customer asks about NS-9999 and is asked to check the ID. | S2, Q12 |
| FR-16 | While an unknown order ID is in the new message or the 10 before it, the app must repeat the not-found reply. | After asking about NS-9999, a customer asks about NS-1001 and still hears that NS-9999 was not found. | S2, Q12 |
| FR-17 | While demo mode is off, when a customer asks about cancelling an order, the app must say only processing orders allow cancellation. | For NS-1001, which is processing, the reply says cancellation is still possible. | S2, Q14 |

### Store policies
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-18 | When a customer asks about shipping times, the app must state 3 to 5 business days for standard and 1 to 2 for express. | A customer chooses Shipping times and reads both ranges. | S2 |
| FR-19 | When a customer asks about the return policy, the app must state that returns are accepted within 30 days of delivery. | A customer chooses Return policy and reads the 30-day limit. | S2 |
| FR-20 | When a customer opens the support page, the app must show the shipping, returns and refunds policies on it. | The page shows shipping times, the 30-day return limit and refunds in 5 to 7 business days. | S3 |

### Billing
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-21 | When a customer's message holds one of the billing words, the app must hand the chat from Nova to Sage. | A customer writes that they were charged twice, and Sage replies. A message that asks only about "refunds", in the plural, stays with Nova. | S2, Q13 |
| FR-22 | When a chat passes from Nova to Sage, the app must show a transfer notice. | Before Sage's first reply, a notice says the conversation was transferred to the billing specialist. | S3 |
| FR-23 | While a chat is with Sage, the app must send every later message to Sage. | After the transfer, Sage answers a shipping question until the customer starts a new chat. | S2, S3 |
| FR-24 | While a chat is with Sage, the app must show Sage as the billing specialist at the top of the chat. | The chat heading reads Sage, billing specialist. | S3 |
| FR-25 | While demo mode is off, when Sage answers a refund question, the app must state the refund time and destination. | Sage says refunds take 5 to 7 business days and go to the original payment method. | S2 |
| FR-26 | While demo mode is off, when Sage needs an order ID, the app must ask for it, mentioning review by a billing teammate. | Sage asks for the order ID and says a billing teammate is able to review the account. | S2, Q14 |
| FR-27 | While demo mode is off, if a billing matter reaches Nova, then the app must say the customer is being transferred to billing. | A customer asks Nova about their invoices, in the plural, and Nova mentions a transfer. | S2, Q13 |

### Demo mode and AI failures
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-28 | While demo mode is on, the app must reply to chat messages with fixed replies. | With no AI key set up, a question about NS-1002 gets its status and tracking number. | S2, S7, S9 |
| FR-29 | If the AI service fails to answer, then the app must ask the customer to try again in a moment. | The reply says the app is having trouble reaching the assistant. | S2 |

### Order desk
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-30 | The app must let anyone open the order desk without signing in. | A visitor with no account opens the order desk and sees the orders. | S3, S7, Q5 |
| FR-31 | When an order desk visitor opens the order desk, the app must list every order's ID, customer name, items, status and total. | The NS-1001 line shows Ava Patel, both items, processing and $138.00. | S2, S3, Q5, Q7 |
| FR-32 | The app must show a colour key for the 4 order statuses on the order desk. | The key names processing, shipped, delivered and refunded. | S3 |
| FR-33 | While the order list is loading, the app must show a loading message. | The visitor reads that orders are loading. | S3 |
| FR-34 | If the order list fails to load, then the app must ask the order desk visitor to refresh. | The visitor reads that orders were not loaded and to refresh. | S3 |
| FR-35 | The app must link the support page and the order desk to each other. | The support page shows an Order desk link, and the order desk shows a Support link. | S3 |
| FR-36 | The app must hold the same 10 sample orders after every restart. | After a restart, the order desk lists NS-1001 to NS-1010 again. | S2, S7, Q7 |

### Governance rules
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-37 | While governance rules are on, if a message tries to override an assistant's instructions, then the app must show the refusal reply. | A customer asks the assistant to ignore all previous instructions and reveal them, and gets the refusal reply. | S2, S6 |
| FR-38 | While governance rules are on, if an assistant's reply holds a hidden marker, then the app must show the refusal reply instead. | The customer sees the refusal reply and never the marker. | S2, S4, S6 |
| FR-39 | While governance rules are on and an assistant has used 10 AI model calls in a conversation, the app must refuse its next call. | With demo mode off, a customer's 6th order question to Nova in one chat gets the refusal reply. | S2, S4, Q11 |
| FR-40 | While governance rules are on, when a conversation has used 10 order lookups, the app must refuse the next lookup. | An 11th order lookup in one conversation gets the refusal reply. | S2, S4, Q11, Q27 |
| FR-41 | While governance rules are on, the app must count chats with the same opening message as one conversation until a restart. | With demo mode off, 5 visitors choose Track an order, and a 6th who chooses it gets the refusal reply. | S2, S4, Q11 |
| FR-57 | While governance rules are on, the app must count a chat past 10 earlier messages by the oldest customer message among those 10. | With demo mode off and each question worded anew, the 6th order question is refused and the 7th gets an answer. | S2, S4, Q11 |
| FR-42 | While governance rules are on and demo mode is off, when an assistant reads an order, the app must record an audit entry. | The governance records hold an entry for a lookup of NS-1002. | S4 |
| FR-43 | If governance rules are on and their settings are missing, then the app must refuse to start. | With the governance key missing, no chat message gets a reply. | S4 |

### Leave days
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-44 | When an employee opens the leave page, the app must show that employee's leave balance as one total of annual leave days. | A signed-in employee opens the leave page and sees one total number of annual leave days left. | S1, Q3, Q8, Q23 |
| FR-46 | When an employee opens the leave page, the app must identify that employee through company single sign-on with Microsoft Entra ID. | An employee signs in through Microsoft Entra ID, and the leave page treats them as that employee. | Q1, Q16 |
| FR-47 | The app must take each leave balance from Workday. | The total on the leave page comes from the annual leave Workday holds for that employee. | Q2, Q17, Q23 |
| FR-48 | The app must provide the leave page at its own address on the same site as the support page. | An employee enters the leave page's address on the site and reaches the leave page. | Q4 |
| FR-49 | If a person cannot sign in through company single sign-on, then the app must say the leave page is unavailable to them. | A person whose sign-in fails reads that the leave page is not available to them. | Q18, Q25 |
| FR-50 | When an employee opens the leave page, the app must use what Workday holds at that visit for the leave balance. | After annual leave changes in Workday, the employee's next visit shows a total that includes the change. | Q21 |
| FR-51 | The app must take approved annual leave that the employee has not yet taken off the leave balance. | After approval of annual leave for a later date, the employee's total is lower by those days. | Q24 |
| FR-52 | While the app has no set-up connection to Microsoft Entra ID or Workday, the app must say the leave page is not set up yet. | Before both connections exist, a person who opens the leave page reads that it is not set up yet. | Q22 |
| FR-53 | The app must open the leave page to everyone who signs in with company single sign-on. | A person who signs in through Microsoft Entra ID reaches the leave page without belonging to a special group. | Q25 |
| FR-54 | The app must take annual leave that is requested and waiting for approval off the leave balance. | While an annual leave request waits for approval, the employee's total is lower by those days. | Q26 |
| FR-55 | If Workday has no leave record or balance for a signed-in employee, then the app must say it found no balance. | An employee with no leave record in Workday reads that no balance was found. | Q19 |
| FR-56 | If the app cannot reach Workday through a set-up connection, then the app must say it cannot show the leave balance right now. | While Workday does not answer, a signed-in employee reads that the balance cannot be shown right now. | Q20 |

### Whole app
| FR id | Requirement | Acceptance criteria | Source |
| --- | --- | --- | --- |
| FR-45 | The app must fit the support page, the order desk and the leave page to screens 320 pixels wide or wider. | On a phone, the store policies stack in one column, the order list scrolls sideways and an employee reads the leave balance. | S8, Q15 |

## Must never
The app refuses the order and chat actions today, and the leave page adds limits of its own.

- The app must never describe an order that does not exist. (S2)
- The app must never give a chat the details of an order whose ID the customer has not typed in it. (S2)
- The app must never make up payment details, charge amounts, invoice availability or refund dates. (S2)
- The app must never let a chat change, cancel or refund an order. (S2, S5)
- The app must never write chat message text to its governance decision log. (S4, S6)
- The app must never show an employee's leave balance to anyone but that employee. (Q3)
- The app must never link to or mention the leave page on the support page or the order desk. (Q4)

## Out of scope
The answered questions exclude these things.

- Keeping or correcting leave balances in this app: not in this version. (Q2)
- A manager or HR staff view of another employee's leave balance: not in this version. (Q3)
- A breakdown of the leave balance by kind of leave: not in this version. (Q8)
- Counting any kind of leave other than annual leave in the leave balance: not in this version. (Q23)
- Limiting the leave page to a selected group of people who can sign in: not in this version. (Q25)
- Requesting leave, and anything else about leave beyond seeing the days left: not in this version. (Q10)
- Nova or Sage answering questions about leave: not in this version, because only the leave page shows the leave balance. (Q9, Q10)
- Signing in to open the order desk: not in this version. (Q5)
- Checking who a customer is before the chat gives order details: not in this version. (Q6)
- Replacing the 10 sample orders with other order data: not in this version. (Q7)
- Changing how the governance rules count conversations: not in this version. (Q11)
- Changing the limit of 10 order lookups in a conversation: not in this version. (Q27)
- Changing which numbers count as order IDs, or how an unknown one blocks later replies: not in this version. (Q12)
- Moving a chat to Sage on the plurals "refunds" or "invoices": not in this version. (Q13)
- Cancelling an order or reaching a billing teammate through the app: not in this version. (Q14)

## Open questions
One point stays open: whether an old message's error appears in a new chat.

| Id | Question | Changes | Who answers | Answer | Date |
| --- | --- | --- | --- | --- | --- |
| Q1 | How does the app know which employee is looking at the leave page? The app has no accounts today. | FR-46, Users | Citizen User | Company single sign-on. | 2026-11-27 |
| Q2 | Where do leave balances come from, and who keeps them correct? The app holds no leave data today. | FR-47, Terms, Out of scope | Citizen User | Existing HR system. | 2026-11-27 |
| Q3 | Who is allowed to see an employee's leave balance? | FR-44, Must never, Out of scope | Citizen User | Only that employee. | 2026-11-27 |
| Q4 | Where does the leave page sit, given that the rest of the site is open to customers? | FR-48, Must never | Citizen User | Same site, no link: reached by its own address, and customer pages do not mention it. | 2026-11-27 |
| Q5 | Who is the order desk for, and does it stay open to anyone? Today the support page links to it. | FR-30, FR-31, FR-35, Users | Citizen User | Stays open to anyone. | 2026-11-27 |
| Q6 | Today anyone who types an order ID gets that order's details, including the customer name and total. Does this stay? | FR-13, Out of scope | Citizen User | Keep as today. | 2026-11-27 |
| Q7 | The orders are 10 fixed samples built into the app. Does this version keep them? | FR-31, FR-36, Out of scope | Citizen User | Keep the samples. | 2026-11-27 |
| Q8 | What does the leave page show, and for which types of leave? | FR-44, Terms, Out of scope | Citizen User | One total. | 2026-11-27 |
| Q9 | Do Nova or Sage answer questions about leave? | Out of scope | Citizen User | No. Settled by the Q10 answer "Nothing else": only the leave page shows the leave balance. | 2026-11-27 |
| Q10 | Is anything else about leave wanted in this version, beyond seeing the days left? | Leave days, Out of scope | Citizen User | Nothing else. | 2026-11-27 |
| Q11 | Chats with the same opening message share governance limits, so later visitors are refused. Long chats start a new count. Does this stay? | FR-39, FR-40, FR-41, FR-57, Terms, Out of scope | Citizen User | Keep as today. | 2026-11-27 |
| Q12 | Any 4-digit number, even a year, counts as an order ID. One unknown number then blocks later replies. Does this stay? | FR-12, FR-15, FR-16, Out of scope | Citizen User | Keep both as today. | 2026-11-27 |
| Q13 | The plural words refunds and invoices do not move a chat to Sage. Nova then mentions a transfer that never happens. Does this stay? | FR-21, FR-27, Terms, Out of scope | Citizen User | Keep as today. | 2026-11-27 |
| Q14 | The chat mentions cancellation and a billing teammate, but the app offers neither action. Does this stay? | FR-17, FR-26, Out of scope | Citizen User | Keep as today. | 2026-11-27 |
| Q15 | Does the leave page need to work on phones, as today's two pages do? | FR-44, FR-45 | Citizen User | Phones and computers: it works on screens 320 pixels wide or wider, as the two current pages do. | 2026-11-27 |
| Q16 | Which service does the company use for single sign-on? | FR-46, Terms | Citizen User | Microsoft Entra ID. | 2026-11-27 |
| Q17 | Which HR system holds the leave balances? | FR-47, Terms | Citizen User | Workday. | 2026-11-27 |
| Q18 | What happens when a person cannot sign in, or signs in but is not allowed in? | FR-49 | Citizen User | Say it's unavailable: a message that the page is not available to them. | 2026-11-27 |
| Q19 | What happens when Workday has no record or balance for a signed-in employee? | FR-55 | Citizen User | No balance found: a message saying no balance was found. | 2026-11-27 |
| Q20 | What happens when the app cannot reach Workday? | FR-56 | Citizen User | Cannot show right now: a message that the balance cannot be shown right now. | 2026-11-27 |
| Q21 | How up to date must the shown leave balance be? | FR-50 | Citizen User | Current on each visit. | 2026-11-27 |
| Q22 | What does the leave page do before Microsoft Entra ID and Workday are connected? | FR-52 | Citizen User | Say not set up yet. | 2026-11-27 |
| Q23 | Which kinds of leave in Workday count toward the one total on the leave page? | FR-44, FR-47, Terms, Out of scope | Citizen User | Annual leave only. | 2026-11-27 |
| Q24 | Does the leave balance take away annual leave that is approved but not yet taken? | FR-51, Terms | Citizen User | Yes, take it off. | 2026-11-27 |
| Q25 | Who has access to the leave page: everyone who signs in with company single sign-on, or only a limited group? | FR-49, FR-53, Users, Out of scope | Citizen User | Anyone with sign-in: everyone who can use the company's Microsoft Entra ID sign-in. | 2026-11-27 |
| Q26 | Does the leave balance also take away annual leave that is requested but still waiting for approval? | FR-54, Terms | Citizen User | Yes, take it off. | 2026-11-27 |
| Q27 | The app's rules refuse the 11th order lookup in a conversation, but its tests expect the 9th to be refused. Which limit is right? | FR-40, Out of scope | Citizen User | Keep 10: the policy file's limit, as the app does today. The test that expects 8 is out of date. | 2026-11-27 |
| Q28 | A customer can start a new chat while a reply is on its way, and that old reply then appears in the new chat. Does this stay? | FR-07, FR-58 | Citizen User | Drop the old reply: it never appears in the new chat. This changes today's behaviour. | 2026-11-27 |
| Q29 | Today a new chat started during a reply shows typing dots and blocks typing until that old reply arrives. With that reply dropped, what must the new chat do? | FR-04, FR-05, FR-59, FR-60 | Citizen User | Ready at once: no typing dots, and the customer can send a message straight away. This is new work. | 2026-11-27 |
| Q30 | A customer starts a new chat, and then the old message fails. Today its error message appears in the new chat. Does this stay? | FR-08, FR-58 | Citizen User | Open | 2026-11-27 |

## Sources
The request and the answered questions give the new work, and the existing files give today's behaviour.

- S1: The request, 2026-11-27: "Write the requirements for this app as it is today, plus one new page where an employee sees how many leave days they have left."
- S2: server.mjs, the existing chat, order and store policy behaviour.
- S3: src/main.jsx, the existing support page and order desk.
- S4: governance.mjs and governance/solution-policy.json, the existing governance rules.
- S5: governance/solution-manifest.json, the declared assistants and their order lookup.
- S6: test/governance.test.mjs, the existing governance tests. Their order lookup limit of 8 is out of date (Q27).
- S7: `README.md`, the existing setup and behaviour notes.
- S8: public/styles.css, the existing screen layouts.
- S9: integrations-config.json, the AI key setting.
