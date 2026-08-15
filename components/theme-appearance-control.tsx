"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function ThemeAppearanceControl({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = !mounted || resolvedTheme !== "light";

  return (
    <div
      className={cn(
        "vital-card flex items-center justify-between gap-4 p-4",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-card-foreground">Appearance</p>
        <p className="text-xs text-muted-foreground">
          Choose how VITAL OS looks on this device. Preference is saved locally.
        </p>
        <p className="pt-1 text-xs font-medium text-foreground">
          Dark Mode
        </p>
      </div>
      <Switch
        checked={isDark}
        onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
        disabled={!mounted}
        aria-label="Toggle dark mode"
      />
    </div>
  );
}
