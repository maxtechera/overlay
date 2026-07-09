import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/AuthGate";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Overlay — any-site page agent",
  description: "Point an agent at any URL. Extract the schema, propose variants, apply them live.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        <TooltipProvider>
          <AuthGate>{children}</AuthGate>
        </TooltipProvider>
      </body>
    </html>
  );
}
