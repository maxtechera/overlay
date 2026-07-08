// Single source of truth — transcribed verbatim from PRD §5. Change via docs PR only.

export type NodeType = "hero" | "section" | "card" | "collection" | "text" | "media" | "link";
export type TextVariant = "h1" | "h2" | "h3" | "p" | "label";

export interface SelectorRef {
  css: string; // best available: #id > [data-*] > structural path
  fingerprint?: string; // normalized text prefix; re-find requires a match
}

export interface PageNode {
  id: string; // "n12"
  path: string; // "hero.headline" — chat/agent/op addressing
  type: NodeType;
  variant?: TextVariant;
  selector: SelectorRef;
  rect: { x: number; y: number; w: number; h: number };
  slots: Record<
    string,
    { kind: "text" | "media" | "link"; text?: string; href?: string; src?: string; alt?: string }
  >;
  facts?: {
    lines?: number; // text wrap count (rect height / line-height)
    fontPx?: number;
    contrast?: number; // WCAG ratio vs effective background (walk up for bg)
    truncated?: boolean;
    focusable?: boolean; // links/CTAs
    missingAlt?: boolean; // media
  };
  classes: string[]; // captured so variants inherit them
  children?: string[];
  via?: "profile" | "framework" | "semantic" | "layout";
}

// MVP op = update-content only. "collection-edit" and "add-section" join in M8.
export type Op = {
  op: "update-content";
  target: string; // node id
  slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
  rationale: string;
};

export interface VariantOp {
  id: string;
  source: "human" | "agent";
  op: Op;
  status: "pending" | "applied" | "rejected" | "failed";
}

export interface Experiment {
  id: string;
  name: string; // "<Component> — <Change idea>" — practitioner naming
  targetPath: string; // must be a real extracted component path
  hypothesis: string; // grounded in the brief (ICP/pain/objection/proof/ADA)
  status: "proposed" | "building" | "ready" | "exported";
  armIds: string[]; // variant ids; control is implicit
  suggestedAllocation?: Record<string, number>; // COM-PRIOR: control 25% fixed, 75% ∝ deltas
}

export interface Variant {
  id: string;
  name: string; // "Pain-point hero" — agent- or human-named
  goal: string;
  segment?: string; // aimed at a brief segment
  experimentId?: string; // this variant is an ARM of an experiment
  ops: VariantOp[];
  score?: ComScore;
}

export interface ComScore {
  control: number; // scores BOTH — the delta is the story
  variant: number;
  delta: number;
  confidence: number;
  reasons: string[];
}

export interface PageBrief {
  seo: {
    title: string;
    metaDescription?: string;
    og: Record<string, string>;
    headingOutline: { level: 1 | 2 | 3; text: string }[];
  };
  icp: string;
  problemStatement: string;
  valueProp: string;
  painPoints: { addressed: string[]; missed: string[] };
  objections: { handled: string[]; unhandled: string[] };
  proofAudit: { present: string[]; missing: string[] };
  ctaAudit: { path: string; text: string; intentStage: string }[];
  a11yAudit: { path: string; issue: string }[]; // ADA rollup from node facts — deterministic
  segments: { name: string; signal: string }[]; // 2-3 audiences + a DETECTABLE signal each
  suggestedGoals: string[];
  tone: string;
  lang: string; // brand language lives here — no separate BrandProfile object
}
