import { useTheme } from "../hooks/useTheme";
import type { ThemeName } from "../../shared/types";

const ORDER: ThemeName[] = ["light", "dark", "sepia"];

const LABELS: Record<ThemeName, { icon: string; title: string }> = {
  light: { icon: "☀", title: "Light mode (click to switch to Dark)" },
  dark: { icon: "☾", title: "Dark mode (click to switch to Sepia)" },
  sepia: { icon: "❀", title: "Sepia mode (click to switch to Light)" },
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const handleClick = () => {
    const idx = ORDER.indexOf(theme);
    const next = ORDER[(idx + 1) % ORDER.length];
    setTheme(next);
  };

  const meta = LABELS[theme];

  return (
    <button
      type="button"
      className={`theme-toggle theme-toggle-${theme}`}
      title={meta.title}
      aria-label={meta.title}
      onClick={handleClick}
    >
      {meta.icon}
    </button>
  );
}
