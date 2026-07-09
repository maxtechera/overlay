"use client";

/**
 * components/SettingsBar.tsx — TECH-SPEC §9/PRD §4.3's Claude-Code-grade controls: model
 * picker (Sonnet default · Haiku cheap · Opus deep) + extended-thinking toggle. Both write
 * straight to useSettingsStore, which lib/agent.ts's runTurn reads fresh on every call — so a
 * change here applies on the NEXT turn with no reload (TECH-SPEC §5).
 *
 * Plain native <select>/<input type=checkbox> rather than the shadcn Select/Switch — a
 * pragmatic, easily-driven-by-Playwright choice for this MVP control surface (functional over
 * polish, per orchestrator directive); styled to match the existing input/button rules in
 * app/globals.css.
 */

import { type ModelId, useSettingsStore } from "@/lib/store";

const MODEL_OPTIONS: { value: ModelId; label: string }[] = [
  { value: "claude-sonnet-4-6", label: "Sonnet (default)" },
  { value: "claude-haiku-4-5", label: "Haiku (cheap)" },
  { value: "claude-opus-4-8", label: "Opus (deep)" },
];

export function SettingsBar() {
  const model = useSettingsStore((s) => s.model);
  const thinking = useSettingsStore((s) => s.thinking);
  const setModel = useSettingsStore((s) => s.setModel);
  const setThinking = useSettingsStore((s) => s.setThinking);

  return (
    <div className="flex items-center gap-3" data-testid="settings-bar">
      <select
        aria-label="Model"
        data-testid="model-select"
        onChange={(e) => setModel(e.currentTarget.value as ModelId)}
        style={{ width: "auto", fontSize: 12, padding: "4px 8px" }}
        value={model}
      >
        {MODEL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <label className={`toggle ${thinking ? "on" : ""}`}>
        <input
          checked={thinking}
          data-testid="thinking-toggle"
          onChange={(e) => setThinking(e.currentTarget.checked)}
          type="checkbox"
        />
        Thinking
      </label>
    </div>
  );
}
