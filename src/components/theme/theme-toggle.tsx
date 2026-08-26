import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle() {
  const { theme, toggleTheme, mounted } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Mudar para tema claro" : "Mudar para tema escuro"}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-all hover:border-primary hover:text-primary hover:shadow-[var(--glow-primary)]"
    >
      {mounted && (
        <>
          <Sun
            className={`absolute h-4 w-4 transition-all ${
              theme === "light"
                ? "rotate-0 scale-100 opacity-100"
                : "rotate-90 scale-0 opacity-0"
            }`}
          />
          <Moon
            className={`absolute h-4 w-4 transition-all ${
              theme === "dark"
                ? "rotate-0 scale-100 opacity-100"
                : "-rotate-90 scale-0 opacity-0"
            }`}
          />
        </>
      )}
      {!mounted && <span className="h-4 w-4" />}
    </button>
  );
}
