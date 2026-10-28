// Mirrors products_unit_check — the DB constraint stays the real guarantee.
export const PRODUCT_UNITS = ["ton", "kg", "lb", "l", "gal", "each"] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

// Spanish display labels for the English-stored unit values — same pattern
// as orders.status: stored in English, displayed in Spanish.
export const UNIT_LABELS: Record<ProductUnit, string> = {
	ton: "Tonelada",
	kg: "Kg",
	lb: "Lb",
	l: "Litro",
	gal: "Galón",
	each: "Unidad",
};

export function isProductUnit(value: unknown): value is ProductUnit
{
	return typeof value === "string" && (PRODUCT_UNITS as readonly string[]).includes(value);
}

// Fixed synonym table (eng review: no guessing beyond this list). Keys are
// already normalized: lowercase, no accents, no dots or spaces.
const UNIT_SYNONYMS: Record<string, ProductUnit> = {
	ton: "ton", tons: "ton", tn: "ton", t: "ton", tonelada: "ton", toneladas: "ton",
	kg: "kg", kgs: "kg", kgr: "kg", kilo: "kg", kilos: "kg", kilogramo: "kg", kilogramos: "kg",
	lb: "lb", lbs: "lb", libra: "lb", libras: "lb",
	l: "l", lt: "l", lts: "l", ltr: "l", ltrs: "l", litro: "l", litros: "l",
	gal: "gal", gals: "gal", gl: "gal", galon: "gal", galones: "gal",
	each: "each", ea: "each", u: "each", und: "each", unds: "each", uni: "each", unidad: "each",
	unidades: "each", "c/u": "each", cu: "each", pza: "each", pzas: "each", pieza: "each", piezas: "each",
};

/** "Galones" → "gal", "Lts." → "l", "saco" → null (the grid keeps the pasted text visible). */
export function parseUnit(text: string): ProductUnit | null
{
	const key = text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[\s.]+/g, "");
	return UNIT_SYNONYMS[key] ?? null;
}
