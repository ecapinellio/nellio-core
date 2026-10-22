"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getOrderDetail, updateOrderDetail, type OrderDetail } from "@/lib/supabase/queries";
import { calculateOrderTotal } from "@/lib/order-math";
import { formatChannel, formatOrderTimestamp } from "@/lib/format";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface OrderDetailDialogProps
{
	orderId: string | null;
	onClose: () => void;
	/** Called after a successful save — OrdersKanban re-fetches the board (design review Decision 3/eng-review Decision 6), this dialog doesn't patch anything itself. */
	onSaved: () => void;
}

interface EditableItem
{
	id: string;
	productName: string;
	quantity: number;
	/** Controlled as a string so a partially-typed number ("1.") doesn't get clobbered by re-parsing — parsed back to a number only on save. */
	priceInput: string;
	originalPriceInput: string;
	priceOverriddenByName: string | null;
	priceOverriddenAt: string | null;
}

function toPriceInput(price: number | null): string
{
	return price !== null ? String(price) : "";
}

/**
 * Mobile-first per the design review's explicit reversal (user's call) of
 * the original "desktop-only for now" recommendation — line items stack
 * below `sm`, go inline at `sm:max-w-xl` and above (Decisions 1, 5, 6).
 */
export function OrderDetailDialog({ orderId, onClose, onSaved }: OrderDetailDialogProps)
{
	const supabase = useMemo(() => createClient(), []);
	const [detail, setDetail] = useState<OrderDetail | null>(null);
	/** Which orderId the last *failed* fetch was for — compared against the current orderId below, so a stale failure from a previously-viewed order never bleeds into a newly-opened one. */
	const [failedOrderId, setFailedOrderId] = useState<string | null>(null);
	const [notes, setNotes] = useState("");
	const [originalNotes, setOriginalNotes] = useState("");
	const [items, setItems] = useState<EditableItem[]>([]);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);

	// No synchronous setState here (React flags that as a cascading-render
	// risk) — loading/error/stale-content are instead DERIVED below by
	// comparing orderId against what `detail`/`failedOrderId` actually hold,
	// so switching to a new order never briefly shows the previous one's data.
	useEffect(() =>
	{
		if (!orderId)
		{
			return;
		}

		let active = true;

		getOrderDetail(supabase, orderId).then(({ data, error }) =>
		{
			if (!active)
			{
				return;
			}
			if (error || !data)
			{
				setFailedOrderId(orderId);
				return;
			}
			setFailedOrderId(null);
			setConfirmingDiscard(false);
			setSaveError(null);
			setDetail(data);
			setNotes(data.notes ?? "");
			setOriginalNotes(data.notes ?? "");
			setItems(data.items.map((item) => ({
				id: item.id,
				productName: item.productName,
				quantity: item.quantity,
				priceInput: toPriceInput(item.priceAtOrder),
				originalPriceInput: toPriceInput(item.priceAtOrder),
				priceOverriddenByName: item.priceOverriddenByName,
				priceOverriddenAt: item.priceOverriddenAt,
			})));
		});

		return () =>
		{
			active = false;
		};
	}, [orderId, supabase]);

	const showContent = detail !== null && detail.id === orderId;
	const showError = failedOrderId !== null && failedOrderId === orderId;
	const showLoading = orderId !== null && !showContent && !showError;

	const isDirty = notes.trim() !== originalNotes.trim()
		|| items.some((item) => item.priceInput !== item.originalPriceInput);

	const orderTotal = calculateOrderTotal(
		items.map((item) => ({ quantity: item.quantity, priceAtOrder: item.priceInput === "" ? null : Number(item.priceInput) })),
	);

	/** Only clears transient UI state — `detail`/`notes`/`items` are left for the next fetch to overwrite, since showContent/showError/showLoading above already gate on orderId matching, so stale leftovers are never rendered. */
	function reset()
	{
		setSaveError(null);
		setConfirmingDiscard(false);
	}

	function attemptClose()
	{
		if (isDirty)
		{
			setConfirmingDiscard(true);
			return;
		}
		reset();
		onClose();
	}

	function discardAndClose()
	{
		reset();
		onClose();
	}

	function updatePriceInput(itemId: string, value: string)
	{
		setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, priceInput: value } : item)));
	}

	async function handleSave()
	{
		if (!orderId)
		{
			return;
		}

		const invalid = items.find((item) => item.priceInput !== "" && Number(item.priceInput) <= 0);
		if (invalid)
		{
			setSaveError(`El precio de "${invalid.productName}" tiene que ser mayor a cero.`);
			return;
		}

		setSaving(true);
		setSaveError(null);

		const priceUpdates = items
			.filter((item) => item.priceInput !== "" && item.priceInput !== item.originalPriceInput)
			.map((item) => ({ orderItemId: item.id, priceAtOrder: Number(item.priceInput) }));

		const { error } = await updateOrderDetail(supabase, orderId, {
			notes: notes.trim() || null,
			priceUpdates,
		});

		setSaving(false);

		if (error)
		{
			setSaveError(error.message || "No se pudo guardar. Intenta de nuevo.");
			return;
		}

		reset();
		onSaved();
	}

	return (
		<Dialog open={orderId !== null} onOpenChange={(open) => { if (!open) attemptClose(); }}>
			<DialogContent className="sm:max-w-xl">
				{confirmingDiscard
					? (
						<>
							<DialogHeader>
								<DialogTitle>Tenés cambios sin guardar</DialogTitle>
								<DialogDescription>Si cerrás ahora, se pierden los cambios que hiciste en este pedido.</DialogDescription>
							</DialogHeader>
							<DialogFooter>
								<Button variant="secondary" className="w-full sm:w-auto" onClick={() => setConfirmingDiscard(false)}>
									Seguir editando
								</Button>
								<Button variant="destructive" className="w-full sm:w-auto" onClick={discardAndClose}>
									Descartar cambios
								</Button>
							</DialogFooter>
						</>
					)
					: showError
						? (
							<>
								<DialogHeader>
									<DialogTitle>No se pudo cargar el pedido</DialogTitle>
									<DialogDescription>Intenta de nuevo o cerrá este dialog.</DialogDescription>
								</DialogHeader>
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertDescription>No se pudo cargar el pedido.</AlertDescription>
								</Alert>
							</>
						)
						: showLoading
							? <p className="py-8 text-center text-sm text-muted-foreground">Cargando...</p>
							: detail && detail.id === orderId && (
								<>
									<DialogHeader>
										<DialogTitle>{detail.customerName}</DialogTitle>
										<DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs tabular-nums">
											<span>#{detail.id.slice(0, 8)}</span>
											<OrderStatusBadge status={detail.status} />
											<span>{formatChannel(detail.channel)}</span>
											<span>{formatOrderTimestamp(detail.createdAt)}</span>
											{detail.customerPhone ? <span>· {detail.customerPhone}</span> : null}
										</DialogDescription>
									</DialogHeader>

									<div className="flex flex-col gap-2">
										<Label htmlFor="order-detail-notes">Notas</Label>
										<Textarea
											id="order-detail-notes"
											rows={4}
											value={notes}
											onChange={(e) => setNotes(e.target.value)}
											className="font-mono text-xs"
										/>
									</div>

									<div className="flex flex-col gap-3 border-t border-border pt-3">
										<Label>Productos</Label>
										{items.map((item) => (
											<div key={item.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
												<span className="truncate text-sm sm:flex-1">{item.productName}</span>
												<div className="flex items-center gap-2">
													<span className="font-mono text-xs tabular-nums text-muted-foreground">{item.quantity}×</span>
													<input
														type="number"
														min="0.01"
														step="0.01"
														placeholder="Sin precio"
														aria-label={`Precio para ${item.productName}`}
														value={item.priceInput}
														onChange={(e) => updatePriceInput(item.id, e.target.value)}
														className="h-11 w-28 rounded-sm border border-input bg-transparent px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-8 sm:w-24"
													/>
												</div>
												{item.priceOverriddenByName && item.priceOverriddenAt
													? (
														<p className="text-xs text-muted-foreground sm:ml-auto">
															editado por {item.priceOverriddenByName} el {formatOrderTimestamp(item.priceOverriddenAt)}
														</p>
													)
													: null}
											</div>
										))}
									</div>

									<div className="flex items-center justify-between border-t border-border pt-3">
										<span className="text-sm font-semibold">Total</span>
										<span className="font-mono text-base font-semibold tabular-nums">
											${orderTotal.total.toFixed(2)}
											{orderTotal.unpricedCount > 0
												? <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">+ {orderTotal.unpricedCount} sin precio</span>
												: null}
										</span>
									</div>

									{saveError
										? (
											<Alert variant="destructive">
												<AlertTriangle />
												<AlertDescription>{saveError}</AlertDescription>
											</Alert>
										)
										: null}

									<DialogFooter>
										<Button variant="secondary" className="w-full sm:w-auto" onClick={attemptClose} disabled={saving}>
											Cancelar
										</Button>
										<Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving}>
											{saving ? "Guardando..." : "Guardar"}
										</Button>
									</DialogFooter>
								</>
							)}
			</DialogContent>
		</Dialog>
	);
}
