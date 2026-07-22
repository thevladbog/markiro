import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);

  useEffect(() => {
    // Check localStorage first
    const stored = localStorage.getItem("markiro.theme") as Theme | null;
    if (stored) {
      setThemeState(stored);
      return;
    }

    // If no stored theme, use default
    const effectiveTheme =
      defaultTheme === "system" ? resolveSystemTheme() : defaultTheme;
    updateDocumentTheme(effectiveTheme);
  }, [defaultTheme]);

  useEffect(() => {
    const effectiveTheme =
      theme === "system" ? resolveSystemTheme() : theme;
    updateDocumentTheme(effectiveTheme);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem("markiro.theme", newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

function resolveSystemTheme(): Exclude<Theme, "system"> {
  if (typeof window === "undefined") return "light";

  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function updateDocumentTheme(theme: Exclude<Theme, "system">) {
  document.documentElement.dataset.theme = theme;
}
