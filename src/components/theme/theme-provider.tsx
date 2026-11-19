"use client";
import { createContext, use, useEffect, useState } from "react";
type Theme = "dark" | "light";
const Context = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
    const sync = (event: StorageEvent) => {
      if (event.key === "draftbranch.theme") {
        const next = event.newValue === "light" ? "light" : "dark";
        setTheme(next);
        document.documentElement.dataset.theme = next;
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("draftbranch.theme", next);
    } catch {}
  }
  return <Context value={{ theme, toggle }}>{children}</Context>;
}
export function ThemeToggle() {
  const { theme, toggle } = use(Context);
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
