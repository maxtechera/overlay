"use client";

/**
 * components/AuthGate.tsx — TECH-SPEC §13 client side.
 * On mount, asks /api/auth for gate status. Gate off (local dev) → renders the app immediately.
 * Gate on + not authed → a single password field over the app; on success the cookie is set and
 * the page reloads so every subsequent API call carries it.
 */

import { useEffect, useState } from "react";

type Phase = "checking" | "authed" | "locked";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d: { authed?: boolean }) => setPhase(d.authed ? "authed" : "locked"))
      .catch(() => setPhase("authed")); // status endpoint unreachable → don't trap the user; API calls still enforce
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(false);
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        setPhase("authed");
        window.location.reload(); // reload so all stores re-init behind the now-set cookie
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") return null;
  if (phase === "authed") return <>{children}</>;

  return (
    <div
      data-testid="auth-gate"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6"
    >
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Overlay</h1>
          <p className="text-sm text-muted-foreground">This deployment is password protected.</p>
        </div>
        <input
          data-testid="auth-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {error && (
          <p data-testid="auth-error" className="text-sm text-destructive">
            Incorrect password.
          </p>
        )}
        <button
          data-testid="auth-submit"
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
