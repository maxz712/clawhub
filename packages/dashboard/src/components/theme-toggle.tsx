"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTheme, setTheme, type Theme } from "@/lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
  // Starts "dark" (the SSR/pre-hydration default) and syncs to whatever
  // THEME_INIT_SCRIPT actually applied once mounted, so the icon never
  // flashes the wrong state.
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => { setThemeState(getTheme()); }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button variant="ghost" size="icon-sm" className={className ?? "size-9 sm:size-7"} onClick={toggle} aria-label={label} title={label}>
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
