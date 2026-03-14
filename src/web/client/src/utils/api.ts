export function getApiBase(): string {
  if (typeof location === "undefined") return "";
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env && typeof env === "string") {
    const base = env.replace(/^ws:/, "http:").replace(/\/ws\/?$/, "");
    if (base) return base;
  }
  return location.origin;
}
