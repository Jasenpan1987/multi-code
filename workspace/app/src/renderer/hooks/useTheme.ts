import { createContext, useContext } from "react";
import type { ThemeName } from "../../shared/types";

export interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (next: ThemeName) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
