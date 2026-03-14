export type PaletteId = "default" | "terracotta" | "teal" | "cobalt" | "gruvbox" | "monokai" | "evergreen" | "lavender";

export interface PaletteMeta {
  name: string;
  swatches: [string, string, string]; // [bg, neutral, accent] for picker preview
}

export const PALETTE_META: Record<PaletteId, PaletteMeta> = {
  default:    { name: "Default",    swatches: ["#fafaf9", "#78716c", "#f59e0b"] },
  terracotta: { name: "Terracotta", swatches: ["#F4F3EE", "#B1ADA1", "#C15F3C"] },
  teal:       { name: "Teal",       swatches: ["#FFFFFF", "#6e6e80", "#10a37f"] },
  cobalt:     { name: "Cobalt",     swatches: ["#F8F9FA", "#5f6368", "#4285F4"] },
  gruvbox:    { name: "Gruvbox",    swatches: ["#fbf1c7", "#3c3836", "#d65d0e"] },
  monokai:    { name: "Monokai",    swatches: ["#f8f8f2", "#797979", "#e87d3e"] },
  evergreen:  { name: "Evergreen",  swatches: ["#F2F5F3", "#232925", "#0FBF3E"] },
  lavender:   { name: "Lavender",   swatches: ["#F5F3FA", "#4A4558", "#7C3AED"] },
};

export const PALETTE_IDS = Object.keys(PALETTE_META) as PaletteId[];
