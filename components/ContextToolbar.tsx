"use client";

/**
 * components/ContextToolbar.tsx — issue #28 item 1: Project Context moves OUT of the chat
 * flow (it used to sit pinned above the transcript, eating vertical space every session) into
 * a toolbar control that opens it on demand. ContextPanel's textarea + Apply flow (localStorage
 * persistence per hostname, injected into buildSystem() every turn — TECH-SPEC §9) is reused
 * verbatim inside the popover; only the shell around it changes.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContextPanel } from "@/components/ContextPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSessionStore } from "@/lib/store";

export function ContextToolbar() {
  const [open, setOpen] = useState(false);
  const hasContext = useSessionStore((s) => s.context.trim().length > 0);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            data-has-context={hasContext}
            data-testid="context-toggle-btn"
            size="sm"
            variant={hasContext ? "secondary" : "outline"}
          />
        }
      >
        Context{hasContext ? " •" : ""}
      </DialogTrigger>
      <DialogContent data-testid="context-dialog">
        <DialogHeader>
          <DialogTitle>Project context</DialogTitle>
          <DialogDescription>
            User-authored, authoritative — injected into every agent turn (e.g. &quot;launching a
            cohort in August; never touch pricing copy&quot;).
          </DialogDescription>
        </DialogHeader>
        <ContextPanel />
      </DialogContent>
    </Dialog>
  );
}
