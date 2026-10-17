import type { Customer } from "@/lib/supabase/queries";
import type { LineItem } from "@/components/capture/line-items";
import { calculateLineTotal } from "@/lib/order-math";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface OrderOverviewProps
{
	customer: Customer | null;
	items: LineItem[];
}

/**
 * Slice 2, Decision 1: order summary — standard checkout-UX pattern (form
 * fields left, live total right). The caller (CaptureForm) is responsible
 * for making the right column sticky as one unit (this + the submit card),
 * not this component alone — a fixed offset here would break the moment
 * either card's height changes. Decision 2: unpriced lines don't block
 * anything, they just don't count toward the total, with an explicit
 * "+N líneas sin precio" indicator instead of a silently-wrong number.
 */
export function OrderOverview({ customer, items }: OrderOverviewProps)
{
	const unpricedCount = items.filter((i) => i.pricePerUnit === null).length;
	const total = items.reduce((sum, i) => sum + (calculateLineTotal(i.quantity, i.pricePerUnit) ?? 0), 0);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Resumen del pedido</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div>
					<p className="text-xs font-medium text-muted-foreground">Cliente</p>
					<p className="text-sm font-medium">{customer?.name ?? "Sin seleccionar"}</p>
				</div>

				{items.length > 0
					? (
						<div className="flex flex-col gap-2 border-t border-border pt-3">
							{items.map((item) =>
							{
								const subtotal = calculateLineTotal(item.quantity, item.pricePerUnit);
								return (
									<div key={item.productId} className="flex items-center justify-between gap-2 text-sm">
										<span className="truncate text-muted-foreground">
											{item.quantity} × {item.productName}
										</span>
										<span className="shrink-0 font-mono tabular-nums">
											{subtotal !== null ? `$${subtotal.toFixed(2)}` : "Sin precio"}
										</span>
									</div>
								);
							})}
						</div>
					)
					: <p className="text-sm text-muted-foreground">Sin productos todavía.</p>}

				<div className="flex items-center justify-between border-t border-border pt-3">
					<span className="text-sm font-semibold">Total</span>
					<span className="font-mono text-base font-semibold tabular-nums">${total.toFixed(2)}</span>
				</div>

				{unpricedCount > 0
					? (
						<p className="text-xs text-muted-foreground">
							+ {unpricedCount} {unpricedCount === 1 ? "línea sin precio" : "líneas sin precio"}
						</p>
					)
					: null}
			</CardContent>
		</Card>
	);
}
