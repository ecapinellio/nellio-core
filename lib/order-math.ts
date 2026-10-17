/**
 * Shared by LineItems and OrderOverview (slice 2 of the product-pricing
 * block) so quantity × price math — and its null handling — lives in one
 * place, not duplicated with a risk of silently diverging.
 *
 * Returns null (not 0) when pricePerUnit is null, so callers can tell
 * "unpriced line" apart from "line that costs nothing" and render
 * "Sin precio" instead of a misleading $0.
 */
export function calculateLineTotal(quantity: number, pricePerUnit: number | null): number | null
{
	if (pricePerUnit === null)
	{
		return null;
	}
	return quantity * pricePerUnit;
}
