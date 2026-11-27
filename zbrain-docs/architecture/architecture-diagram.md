# Architecture diagram: Northstar Support Portal

```mermaid
flowchart LR
  customer["Customer<br/>Person"]
  visitor["Order desk visitor<br/>Person"]
  employee["Employee<br/>Person"]
  subgraph aws ["Customer AWS account"]
    web["Web app<br/>Single-page app: React, Vite"]
    api["Portal service<br/>Service: Node.js, Express"]
  end
  openai["OpenAI<br/>Outside system: AI service"]
  gov["ZBrain Governance service<br/>Outside system: policy and audit"]
  entra["Microsoft Entra ID<br/>Outside system: company sign-in"]
  workday["Workday<br/>Outside system: HR system"]
  fonts["Google Fonts<br/>Outside system: web fonts"]
  customer -->|"Chats about orders, rules and billing: HTTP"| web
  visitor -->|"Reads the order list: HTTP"| web
  employee -->|"Reads their leave days left: HTTPS"| web
  employee -->|"Signs in with the company account: HTTPS"| entra
  web -->|"Sends chat, order, sign-in and leave days requests: JSON over HTTP"| api
  web -->|"Loads page fonts: HTTPS"| fonts
  api -->|"Asks for Nova and Sage replies: JSON over HTTPS"| openai
  api -->|"Registers, gets rules and sends audit records: JSON over HTTP"| gov
  api -->|"Completes and checks the company sign-in: HTTPS"| entra
  api -->|"Finds the employee and reads their annual leave balance: HTTPS"| workday
```

Container diagram of the whole portal, including the leave days connections. Boxes are people, running parts or outside systems, and arrows show who starts each call. The box "Customer AWS account" holds the Portal service and the Web app files it serves, although the Web app runs in the browser. Browser redirects during sign-in are left out, and nothing is grouped.
