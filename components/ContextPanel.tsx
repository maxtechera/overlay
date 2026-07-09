"use client";

/**
 * components/ContextPanel.tsx — PRD §4.3's user-authored project context panel: "we're
 * launching a cohort in August; never touch pricing copy" — editable, injected into
 * buildSystem() every turn (localStorage-persisted per hostname until M4's .memory/ takes
 * over — TECH-SPEC §9).
 */

import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/lib/store";

export function ContextPanel() {
  const context = useSessionStore((s) => s.context);
  const setContext = useSessionStore((s) => s.setContext);
  const [draft, setDraft] = useState(context);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(context);
  }, [context]);

  const commit = () => {
    editingRef.current = false;
    if (draft !== context) setContext(draft);
  };

  return (
    <div className="chat-input" data-testid="context-panel" style={{ flex: "none" }}>
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide" style={{ marginBottom: 6 }}>
        Project context
      </div>
      <textarea
        data-testid="context-textarea"
        onBlur={commit}
        onChange={(e) => {
          editingRef.current = true;
          setDraft(e.currentTarget.value);
        }}
        placeholder="e.g. launching a cohort in August; never touch pricing copy"
        rows={2}
        style={{ width: "100%", fontSize: 12, resize: "vertical" }}
        value={draft}
      />
      <button data-testid="context-save" onClick={commit} style={{ marginTop: 6, fontSize: 12 }} type="button">
        Apply
      </button>
    </div>
  );
}
