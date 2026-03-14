import { useTheme } from "../../theme";
import { PALETTE_IDS, PALETTE_META } from "../../theme/palettes";

export function PaletteSettings() {
  const { palette, setPalette, fontSize, setFontSize } = useTheme();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Color Palette
        </label>
        <div className="grid grid-cols-2 gap-2">
          {PALETTE_IDS.map((id) => {
            const meta = PALETTE_META[id];
            const active = palette === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPalette(id)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "border-amber-500 bg-amber-50 dark:bg-amber-950/30 ring-2 ring-amber-500/30"
                    : "border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600"
                }`}
              >
                <div className="flex gap-1">
                  {meta.swatches.map((color, i) => (
                    <span
                      key={i}
                      className="inline-block h-4 w-4 rounded-full border border-stone-300 dark:border-stone-600"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                <span className="text-stone-700 dark:text-stone-300">{meta.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-400">
          Font Size
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFontSize(fontSize - 1)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-700 transition-colors hover:border-stone-300 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600"
          >
            −
          </button>
          <input
            type="number"
            min={10}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="h-8 w-16 rounded-lg border border-stone-200 bg-transparent text-center text-sm text-stone-700 dark:border-stone-700 dark:text-stone-300"
          />
          <span className="text-xs text-stone-400 dark:text-stone-500">px</span>
          <button
            type="button"
            onClick={() => setFontSize(fontSize + 1)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone-200 text-sm text-stone-700 transition-colors hover:border-stone-300 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
