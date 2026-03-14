import { useState, useRef, useCallback, useEffect } from "react";

interface UseResizableOptions {
  minHeight: number;
  maxHeight: number;
  initialHeight: number;
  storageKey: string;
  onResizeEnd?: () => void;
}

function readStoredHeight(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // localStorage unavailable
  }
  return fallback;
}

export function useResizable({
  minHeight,
  maxHeight,
  initialHeight,
  storageKey,
  onResizeEnd,
}: UseResizableOptions) {
  const [height, setHeight] = useState(() =>
    Math.min(maxHeight, Math.max(minHeight, readStoredHeight(storageKey, initialHeight))),
  );
  const [isDragging, setIsDragging] = useState(false);

  const clientYRef = useRef(0);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const rafRef = useRef(0);
  const draggingRef = useRef(false);

  const clamp = useCallback(
    (v: number) => Math.min(maxHeight, Math.max(minHeight, v)),
    [minHeight, maxHeight],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      clientYRef.current = e.clientY;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (!draggingRef.current) return;
        const delta = startYRef.current - clientYRef.current;
        setHeight(clamp(startHeightRef.current + delta));
      });
    },
    [clamp],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
    setIsDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    // Persist height
    setHeight((h) => {
      try {
        localStorage.setItem(storageKey, String(h));
      } catch {
        // ignore
      }
      return h;
    });
    onResizeEnd?.();
  }, [onPointerMove, storageKey, onResizeEnd]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      draggingRef.current = true;
      setIsDragging(true);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [height, onPointerMove, onPointerUp],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [onPointerMove, onPointerUp]);

  const handleProps = {
    onPointerDown,
    style: { cursor: "row-resize" as const },
  };

  return { height, isDragging, handleProps };
}
