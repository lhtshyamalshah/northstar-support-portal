import { useEffect, useState } from "react";

const SIGN_IN_STARTED_KEY = "northstar.leaveSignInStartedAt";
// A second "not signed in" this soon after starting a sign-in means the sign-in did not stick.
const SIGN_IN_LOOP_MS = 30_000;

/** Today's date where the employee is, as YYYY-MM-DD. */
function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// The page shows the leave days left and nothing else. Every failure shows the same
// plain message and never a number.
export default function LeavePage() {
  const [view, setView] = useState({ status: "loading" });

  useEffect(() => {
    document.title = "Northstar — Leave days";

    if (new URLSearchParams(window.location.search).get("sign-in") === "failed") {
      setView({ status: "unavailable" });
      return undefined;
    }

    let active = true;
    async function load() {
      const response = await fetch(`/api/leave-days?asOfDate=${localDate()}`, { cache: "no-store" });
      if (!active) return;

      if (response.status === 401) {
        const startedAt = Number(window.sessionStorage.getItem(SIGN_IN_STARTED_KEY) || 0);
        if (Date.now() - startedAt < SIGN_IN_LOOP_MS) throw new Error("Sign-in did not complete.");
        window.sessionStorage.setItem(SIGN_IN_STARTED_KEY, String(Date.now()));
        window.location.assign("/api/auth/sign-in");
        return;
      }

      if (!response.ok) throw new Error("Leave days are not available.");
      const { daysLeft } = await response.json();
      if (!active) return;
      window.sessionStorage.removeItem(SIGN_IN_STARTED_KEY);
      setView({ status: "ready", daysLeft });
    }

    load().catch(() => {
      if (active) setView({ status: "unavailable" });
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="leave-shell">
      <section className="leave-card" aria-live="polite">
        <h1>Annual leave days left</h1>
        {view.status === "loading" && <p>Loading…</p>}
        {view.status === "ready" && <p className="leave-number">{view.daysLeft}</p>}
        {view.status === "unavailable" && <p>Your leave days can’t be shown right now.</p>}
      </section>
    </main>
  );
}
