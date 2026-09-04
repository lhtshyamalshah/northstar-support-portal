import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const initialMessage = {
  role: "assistant",
  agent: "support",
  content: "Hi, I’m Nova. I can help with your order, shipping, returns, or cancellations. What can I look into?"
};

const quickActions = [
  ["Track an order", "Where is my order NS-1002?"],
  ["Return policy", "What is your return policy?"],
  ["Shipping times", "What are your shipping times?"]
];

function Header({ admin = false }) {
  return (
    <header className={`topbar ${admin ? "admin-topbar" : ""}`}>
      <a className="wordmark" href="/" aria-label="Northstar support home">Northstar<span>®</span></a>
      <nav aria-label="Primary navigation">
        {admin ? <a href="/">Support <span aria-hidden="true">↗</span></a> : <><a href="#policies">Help center</a><a href="/admin">Order desk <span aria-hidden="true">↗</span></a></>}
      </nav>
    </header>
  );
}

function AgentAvatar({ agent, large = false }) {
  const billing = agent === "billing";
  return <div className={`${large ? "agent-mark" : "message-avatar"} ${billing ? large ? "billing-mark" : "billing-avatar" : ""}`}>{billing ? "S" : "N"}</div>;
}

function SupportPage() {
  const [messages, setMessages] = useState([initialMessage]);
  const [history, setHistory] = useState([]);
  const [activeAgent, setActiveAgent] = useState("support");
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isSending]);

  async function sendMessage(rawMessage) {
    const message = rawMessage.trim();
    if (!message || isSending) return;

    const userMessage = { role: "user", content: message };
    const requestHistory = [...history, userMessage];
    setMessages((current) => [...current, userMessage]);
    setHistory(requestHistory);
    setInput("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, activeAgent })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to send message.");

      const assistantMessage = { role: "assistant", agent: data.agent, content: data.reply };
      setActiveAgent(data.agent);
      setMessages((current) => [
        ...current,
        ...(data.handoff ? [{ role: "handoff", content: "Conversation transferred to Sage · Billing specialist" }] : []),
        assistantMessage
      ]);
      setHistory((current) => [...current, assistantMessage]);
    } catch (error) {
      const fallback = { role: "assistant", agent: activeAgent, content: error.message || "Something went wrong. Please try again." };
      setMessages((current) => [...current, fallback]);
      setHistory((current) => [...current, fallback]);
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }

  function startOver() {
    setMessages([initialMessage]);
    setHistory([]);
    setActiveAgent("support");
    setInput("");
    inputRef.current?.focus();
  }

  const billing = activeAgent === "billing";
  return (
    <main className="support-shell">
      <Header />
      <section className="hero">
        <p className="eyebrow"><span /> Customer care, made simple</p>
        <h1>How can we<br /><em>help today?</em></h1>
        <p className="hero-copy">Ask about an order, delivery, returns, or billing. We’ll get you to the right person.</p>
      </section>

      <section className="chat-card" aria-label="Support conversation">
        <div className="chat-heading">
          <AgentAvatar agent={activeAgent} large />
          <div>
            <p className="agent-label">{billing ? "SAGE · BILLING SPECIALIST" : "NOVA · STORE SUPPORT"}</p>
            <div className="availability"><span /> <span>{billing ? "Billing specialist is here" : "Usually replies instantly"}</span></div>
          </div>
          <button className="restart-button" onClick={startOver} type="button" title="Start a new conversation">↻ <span>New chat</span></button>
        </div>

        <div className="message-list" ref={listRef} aria-live="polite">
          {messages.map((message, index) => {
            if (message.role === "handoff") return <p className="handoff-notice" key={`${message.content}-${index}`}>{message.content}</p>;
            return (
              <article className={`message ${message.role}-message`} key={`${message.role}-${index}`}>
                {message.role === "assistant" && <AgentAvatar agent={message.agent} />}
                <p>{message.content}</p>
              </article>
            );
          })}
          {isSending && <article className="message assistant-message typing-message"><AgentAvatar agent={activeAgent} /><p><span /><span /><span /></p></article>}
        </div>

        {!messages.some((message) => message.role === "user") && <div className="quick-actions" aria-label="Quick questions">
          {quickActions.map(([label, message]) => <button key={label} type="button" onClick={() => sendMessage(message)}>{label}</button>)}
        </div>}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(input); }}>
          <label className="sr-only" htmlFor="message-input">Your message</label>
          <input ref={inputRef} id="message-input" value={input} onChange={(event) => setInput(event.target.value)} disabled={isSending} autoComplete="off" placeholder="Type your question..." maxLength="2000" />
          <button className="send-button" type="submit" disabled={isSending} aria-label="Send message">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-5.2 16-2.7-6.1L4 12Zm8.1 1.9 2.7 6.1L20 4 4 12l8.1 1.9Z" /></svg>
          </button>
        </form>
        <p className="privacy-note">Your order details are only used to answer this conversation.</p>
      </section>

      <section className="policy-strip" id="policies">
        <article><span className="policy-icon">↗</span><div><h2>Shipping</h2><p>Standard: 3–5 days<br />Express: 1–2 days</p></div></article>
        <article><span className="policy-icon">↺</span><div><h2>Easy returns</h2><p>Within 30 days<br />of delivery</p></div></article>
        <article><span className="policy-icon">◌</span><div><h2>Refunds</h2><p>Processed in 5–7<br />business days</p></div></article>
      </section>
    </main>
  );
}

function AdminPage() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/orders")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((data) => setOrders(data.orders))
      .catch(() => setError(true));
  }, []);

  return (
    <main className="admin-shell">
      <Header admin />
      <section className="admin-intro">
        <p className="eyebrow"><span /> Internal view</p>
        <div className="intro-line"><h1>Order <em>desk.</em></h1><p>10 orders in the current in-memory workspace.</p></div>
      </section>
      <section className="order-panel" aria-label="Orders">
        <div className="table-toolbar">
          <p>{error ? "Orders could not be loaded. Refresh to try again." : orders.length ? `${orders.length} seeded orders · live in this session` : "Loading orders…"}</p>
          <div className="legend" aria-label="Order status legend"><span><i className="dot processing" />Processing</span><span><i className="dot shipped" />Shipped</span><span><i className="dot delivered" />Delivered</span><span><i className="dot refunded" />Refunded</span></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Status</th><th className="amount">Total</th></tr></thead>
            <tbody>{orders.map((order) => <tr key={order.id}><td className="order-id">{order.id}</td><td>{order.customer}</td><td className="items-cell">{order.items.join(" · ")}</td><td><span className={`status status-${order.status}`}>{order.status}</span></td><td className="amount">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(order.total)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

const admin = window.location.pathname === "/admin";
document.body.className = admin ? "admin-body" : "";
createRoot(document.querySelector("#root")).render(<StrictMode>{admin ? <AdminPage /> : <SupportPage />}</StrictMode>);
