"use client";

/**
 * components/ContextPanel.tsx — PRD §4.3's user-authored project context panel: "we're
 * launching a cohort in August; never touch pricing copy" — editable, injected into
 * buildSystem() every turn (localStorage-persisted per hostname until M4's .memory/ takes
 * over — TECH-SPEC §9).
 *
 * Issue #28 (item 1): this is now mounted inside ContextToolbar's popover (opened on demand
 * from a toolbar button) rather than pinned above the chat transcript — the persistence
 * behavior below is unchanged, only the surrounding shell moved.
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
    <div data-testid="context-panel">
      <textarea
        data-testid="context-textarea"
        onBlur={commit}
        onChange={(e) => {
          editingRef.current = true;
          setDraft(e.currentTarget.value);
        }}
        placeholder="e.g. launching a cohort in August; never touch pricing copy"
        rows={4}
        style={{ width: "100%", fontSize: 13, resize: "vertical" }}
        value={draft}
      />
      <button data-testid="context-save" onClick={commit} style={{ marginTop: 8, fontSize: 12 }} type="button">
        Apply
      </button>
    </div>
  );
}
