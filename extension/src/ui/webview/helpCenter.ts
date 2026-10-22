/** URL estável do Help Center por identificador interno, sem depender de rótulos traduzidos. */
export function helpCenterUrl(typeId?: string): string {
  const base = "https://lasec-ufu.github.io/LasecSimul/";
  if (!typeId) return base;
  const slug = typeId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? `${base}components/${slug}.html` : base;
}
