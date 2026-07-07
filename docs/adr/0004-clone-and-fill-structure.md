# 0004 — New sections are clone-and-fill, never free generation

**Decision (M8):** `add-section` deep-clones a donor pattern already on the page and fills typed slots; a11y enforced at fill time. Donor-less pages: refuse, don't generate.
**Why:** squeezes the parameter space — on-brand by construction instead of by hope. Free HTML generation is where on-brand-ness genuinely fails.
