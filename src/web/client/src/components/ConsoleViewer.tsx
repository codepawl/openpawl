import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { subscribeToTerminalOutput } from "../ws/store";
import { useTheme } from "../theme";

function resolveTermTheme(isDark: boolean) {
  const style = getComputedStyle(document.documentElement);
  const get = (v: string) => style.getPropertyValue(v).trim() || undefined;
  const withAlpha = (hex: string | undefined, alpha: string) =>
    hex ? hex + alpha : undefined;

  return {
    background:          get(isDark ? "--color-stone-950" : "--color-stone-50")  ?? (isDark ? "#1a1815" : "#fafaf9"),
    foreground:          get(isDark ? "--color-stone-300" : "--color-stone-700") ?? (isDark ? "#d4d4d4" : "#44403c"),
    cursor:              get("--color-amber-500")                               ?? "#f59e0b",
    cursorAccent:        get(isDark ? "--color-stone-950" : "--color-stone-50")  ?? (isDark ? "#1a1815" : "#fafaf9"),
    selectionBackground: withAlpha(get("--color-amber-500"), "40")              ?? "#f59e0b40",
  };
}

export interface ConsoleViewerHandle {
  fit: () => void;
}

export const ConsoleViewer = forwardRef<ConsoleViewerHandle>(function ConsoleViewer(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { isDark, palette } = useTheme();

  useImperativeHandle(ref, () => ({
    fit: () => {
      fitAddonRef.current?.fit();
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      theme: resolveTermTheme(isDark),
      convertEol: true,
      disableStdin: true,
      scrollback: 2000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    term.writeln("\x1b[90m[TeamClaw] Console ready.\x1b[0m");

    const unsub = subscribeToTerminalOutput((data) => {
      term.write(data);
    });

    // Fallback: refit on window resize
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitAddon.fit(), 150);
    };
    window.addEventListener("resize", onResize);

    return () => {
      unsub();
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolveTermTheme(isDark);
    }
  }, [isDark, palette]);

  return <div ref={containerRef} className="h-full w-full" />;
});
