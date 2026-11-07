"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { createOrder, getOrderDetail, listOrderStatuses, updateOrderDetail, type OrderDetail } from "@/lib/supabase/queries";
import { DEFAULT_STATUSES } from "@/lib/orders/board";
import { detailActions, pendingLines, pendingNote } from "@/lib/orders/detail";
import { isEditable, type OrderStatusDef } from "@/lib/orders/fulfillment";
import { calculateOrderTotal } from "@/lib/order-math";
import { formatChannel, formatOrderTimestamp } from "@/lib/format";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { AssignOrderPanel, type AssignMode, type AssignOutcome, type AssignTarget } from "@/components/orders/assign-order-panel";
import { CancelOrderDialog, type ActionOutcome } from "@/components/orders/cancel-order-dialog";
import { CorrectStatusDialog } from "@/components/orders/correct-status-dialog";
import { DeliveryProof } from "@/components/orders/delivery-proof";
import { OrderTimeline } from "@/components/orders/order-timeline";
import { TrackingLink } from "@/components/orders/tracking-link";
import { InvoiceBlock } from "@/components/orders/invoice-block";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { FormPanel, FormPanelFooter, FormPanelHeader } from "@/components/form-panel";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface OrderDetailPanelProps
{
	orderId: string | null;
	onClose: () => void;
	/** Called after a successful save — OrdersKanban re-fetches the board (design review Decision 3/eng-review Decision 6), this panel doesn't patch anything itself. */
	onSaved: () => void;
	/** Role from the JWT, resolved on the server page: only admins see "Corregir estado". */
	isAdmin: boolean;
}

/** Everything an open action needs, frozen when it opened: the status is the one the user saw, so a colleague's change is rejected (PT409). */
type OpenAction =
	| { kind: "cancel" | "correct"; status: string }
	| { kind: "assign"; mode: AssignMode; status: string; target: AssignTarget };

interface EditableItem
{
	id: string;
	productName: string;
	quantity: number;
	/** Controlled as a string so a partially-typed number ("1.") doesn't get clobbered by re-parsing — parsed back to a number only on save. */
	priceInput: string;
	originalPriceInput: string;
	/** The price as loaded: the save only goes through if the line still holds it. */
	originalPrice: number | null;
	priceOverriddenByName: string | null;
	priceOverriddenAt: string | null;
}

function toPriceInput(price: number | null): string
{
	return price !== null ? String(price) : "";
}

/**
 * Mobile-first per the design review's explicit reversal (user's call) of
 * the original "desktop-only for now" recommendation (Decisions 1, 5, 6).
 * In the shared FormPanel since 2026-11-03 (DESIGN.md): from the right on
 * desktop with the board still in view, from the bottom on a phone. Line
 * items stack below `sm`. "Cambios sin guardar" is a short decision, so it's a
 * centered Dialog on top.
 */
export function OrderDetailPanel({ orderId, onClose, onSaved, isAdmin }: OrderDetailPanelProps)
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
	/** Someone changed what this panel was editing: nothing was saved. */
	const [conflict, setConflict] = useState(false);
	// Bumped by "Ver la versión actual" to load the order again.
	const [loadCount, setLoadCount] = useState(0);
	const [statuses, setStatuses] = useState<OrderStatusDef[]>(DEFAULT_STATUSES);
	const [action, setAction] = useState<OpenAction | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [creatingPending, setCreatingPending] = useState(false);

	// The tenant's own status names and categories; the ECTEC defaults only if this fails.
	useEffect(() =>
	{
		let active = true;
		listOrderStatuses(supabase).then(({ data }) =>
		{
			if (active && data && data.length > 0)
			{
				setStatuses(data);
			}
		});
		return () => { active = false; };
	}, [supabase]);

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
			setConflict(false);
			setDetail(data);
			setNotes(data.notes ?? "");
			setOriginalNotes(data.notes ?? "");
			setItems(data.items.map((item) => ({
				id: item.id,
				productName: item.productName,
				quantity: item.quantity,
				priceInput: toPriceInput(item.priceAtOrder),
				originalPriceInput: toPriceInput(item.priceAtOrder),
				originalPrice: item.priceAtOrder,
				priceOverriddenByName: item.priceOverriddenByName,
				priceOverriddenAt: item.priceOverriddenAt,
			})));
		});

		return () =>
		{
			active = false;
		};
	}, [orderId, supabase, loadCount]);

	const showContent = detail !== null && detail.id === orderId;
	const showError = failedOrderId !== null && failedOrderId === orderId;
	const showLoading = orderId !== null && !showContent && !showError;

	const statusDef = detail ? statuses.find((s) => s.key === detail.status) : undefined;
	// Unknown status: lock rather than let a stale guess through (the server decides anyway).
	const editable = statusDef !== undefined && isEditable(statusDef);
	const actions = detailActions(statusDef, isAdmin);

	const isDirty = notes.trim() !== originalNotes.trim()
		|| items.some((item) => item.priceInput !== item.originalPriceInput);

	const orderTotal = calculateOrderTotal(
		items.map((item) => ({ quantity: item.quantity, priceAtOrder: item.priceInput === "" ? null : Number(item.priceInput) })),
	);

	/** Only clears transient UI state — `detail`/`notes`/`items` are left for the next fetch to overwrite, since showContent/showError/showLoading above already gate on orderId matching, so stale leftovers are never rendered. */
	function reset()
	{
		setSaveError(null);
		setConflict(false);
		setConfirmingDiscard(false);
		setActionError(null);
		setAction(null);
	}

	function openAction(next: OpenAction)
	{
		setActionError(null);
		setAction(next);
	}

	function openAssign(mode: AssignMode)
	{
		if (!detail)
		{
			return;
		}
		const target = {
			id: detail.id,
			customerName: detail.customerName,
			deliveryDate: detail.deliveryDate,
			deliveryWindow: detail.deliveryWindow,
		};
		openAction({ kind: "assign", mode, status: detail.status, target });
	}

	function handleActionDone(outcome: ActionOutcome | AssignOutcome)
	{
		setAction(null);
		if (outcome === "saved")
		{
			reset();
			onSaved();
		}
		else if (outcome === "stale")
		{
			setActionError("Alguien cambió este pedido mientras tanto. No se guardó nada; ya ves la versión actual.");
			setLoadCount((n) => n + 1);
		}
	}

	async function handleCreatePending()
	{
		if (!detail)
		{
			return;
		}
		const lines = pendingLines(detail.items);
		if (lines.length === 0)
		{
			setActionError("No queda nada pendiente en este pedido.");
			return;
		}
		setCreatingPending(true);
		setActionError(null);
		const { error } = await createOrder(supabase, {
			customer_id: detail.customerId,
			notes: pendingNote(detail.createdAt),
			items: lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
		});
		if (error)
		{
			setCreatingPending(false);
			setActionError("No se pudo crear el pedido pendiente. Intenta de nuevo.");
			return;
		}
		// Closing (like the other actions) removes the button, so it can't be clicked twice.
		setCreatingPending(false);
		reset();
		onSaved();
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
		setConflict(false);

		// Only what this panel changed, each with the value it loaded: two
		// people on the same order don't overwrite each other (TODOS.md P2).
		const priceUpdates = items
			.filter((item) => item.priceInput !== "" && item.priceInput !== item.originalPriceInput)
			.map((item) => ({ orderItemId: item.id, priceAtOrder: Number(item.priceInput), expectedPriceAtOrder: item.originalPrice }));
		const notesChanged = notes.trim() !== originalNotes.trim();

		const { error } = await updateOrderDetail(supabase, orderId, notesChanged
			? { notes: notes.trim() || null, expectedNotes: detail?.notes ?? null, priceUpdates }
			: { priceUpdates });

		setSaving(false);

		if (error)
		{
			if (error.code === "PT409")
			{
				setConflict(true);
				return;
			}
			setSaveError(error.message || "No se pudo guardar. Intenta de nuevo.");
			return;
		}

		reset();
		onSaved();
	}

	return (
		<>
			{/* Not while saving: the save would land after the panel moved on to another order and close it. */}
			<FormPanel open={orderId !== null} onOpenChange={(open) => { if (!open && !saving) attemptClose(); }}>
				{showError
					? (
						<>
							<FormPanelHeader>
								<SheetTitle>No se pudo cargar el pedido</SheetTitle>
								<SheetDescription>Intenta de nuevo o cierra el panel.</SheetDescription>
							</FormPanelHeader>
							<div className="px-4 pb-4">
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertDescription>No se pudo cargar el pedido.</AlertDescription>
								</Alert>
							</div>
						</>
					)
					: showLoading
						? (
							<>
								<FormPanelHeader>
									<SheetTitle>Pedido</SheetTitle>
									<SheetDescription className="sr-only">Cargando el pedido.</SheetDescription>
								</FormPanelHeader>
								<p className="py-8 text-center text-sm text-muted-foreground">Cargando...</p>
							</>
						)
						: detail && detail.id === orderId && (
							<div className="flex min-h-full flex-col">
								<FormPanelHeader>
									<SheetTitle>{detail.customerName}</SheetTitle>
									<SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs tabular-nums">
										<span>#{detail.id.slice(0, 8)}</span>
										<OrderStatusBadge status={detail.status} def={statusDef} />
										<span>{formatChannel(detail.channel)}</span>
										<span>{formatOrderTimestamp(detail.createdAt)}</span>
										{detail.customerPhone ? <span>· {detail.customerPhone}</span> : null}
									</SheetDescription>
								</FormPanelHeader>

								<div className="flex flex-col gap-4 px-4 pb-4">
									<div className="flex flex-col gap-2">
										<Label htmlFor="order-detail-notes">Notas</Label>
										<Textarea
											id="order-detail-notes"
											rows={4}
											value={notes}
											onChange={(e) => setNotes(e.target.value)}
											disabled={!editable}
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
														disabled={!editable}
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

									{!editable
										? <p className="text-xs text-muted-foreground">El pedido ya salió; no se puede editar.</p>
										: null}

									<DeliveryProof detail={detail} />

									{actions.reassign || actions.reprogram || actions.cancel || actions.correct || actions.createPending
										? (
											<div className="flex flex-wrap gap-2 border-t border-border pt-3">
												{actions.reassign
													? <Button variant="outline" className="h-11 md:h-9" onClick={() => openAssign("reassign")}>Reasignar</Button>
													: null}
												{actions.reprogram
													? <Button variant="outline" className="h-11 md:h-9" onClick={() => openAssign("reprogram")}>Reprogramar</Button>
													: null}
												{actions.createPending
													? (
														<Button variant="outline" className="h-11 md:h-9" onClick={handleCreatePending} disabled={creatingPending}>
															{creatingPending ? "Creando..." : "Crear pedido con lo pendiente"}
														</Button>
													)
													: null}
												{actions.correct
													? <Button variant="outline" className="h-11 md:h-9" onClick={() => openAction({ kind: "correct", status: detail.status })}>Corregir estado</Button>
													: null}
												{actions.cancel
													? <Button variant="destructive" className="h-11 md:h-9" onClick={() => openAction({ kind: "cancel", status: detail.status })}>Cancelar pedido</Button>
													: null}
											</div>
										)
										: null}

									{actionError
										? (
											<Alert variant="destructive">
												<AlertTriangle />
												<AlertDescription>{actionError}</AlertDescription>
											</Alert>
										)
										: null}

									<TrackingLink token={detail.trackingToken} customerEmail={detail.customerEmail} />

									<InvoiceBlock detail={detail} isAdmin={isAdmin} onChanged={() => setLoadCount((n) => n + 1)} />

									<div className="flex flex-col gap-3 border-t border-border pt-3">
										<Label>Historial</Label>
										<OrderTimeline events={detail.events} statuses={statuses} />
									</div>

									{saveError
										? (
											<Alert variant="destructive">
												<AlertTriangle />
												<AlertDescription>{saveError}</AlertDescription>
											</Alert>
										)
										: null}

									{conflict
										? (
											<Alert variant="destructive">
												<AlertTriangle />
												<AlertDescription className="flex flex-col items-start gap-2">
													Alguien cambió este pedido mientras lo editabas. No se guardó nada.
													<Button type="button" variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setLoadCount((n) => n + 1)}>
														Ver la versión actual
													</Button>
												</AlertDescription>
											</Alert>
										)
										: null}
								</div>

								<FormPanelFooter>
									<Button variant="secondary" className="h-11 md:h-9" onClick={attemptClose} disabled={saving}>
										{editable ? "Cancelar" : "Cerrar"}
									</Button>
									{editable
										? (
											<Button className="h-11 md:h-9" onClick={handleSave} disabled={saving}>
												{saving ? "Guardando..." : "Guardar"}
											</Button>
										)
										: null}
								</FormPanelFooter>
							</div>
						)}
			</FormPanel>

			<AssignOrderPanel
				order={action?.kind === "assign" ? action.target : null}
				mode={action?.kind === "assign" ? action.mode : "reassign"}
				expectedStatus={action?.status ?? ""}
				onDone={handleActionDone}
			/>

			{detail && action?.kind === "cancel"
				? <CancelOrderDialog orderId={detail.id} expectedStatus={action.status} onDone={handleActionDone} />
				: null}
			{detail && action?.kind === "correct"
				? (
					<CorrectStatusDialog
						orderId={detail.id}
						expectedStatus={action.status}
						statuses={statuses}
						hasDeliveryProof={detail.delivery !== null && detail.delivery.outcome !== "failed"}
						onDone={handleActionDone}
					/>
				)
				: null}

			<Dialog open={confirmingDiscard} onOpenChange={(open) => { if (!open) setConfirmingDiscard(false); }}>
				<DialogContent
					showCloseButton={false}
					className="sm:max-w-md"
					onCloseAutoFocus={(e) =>
					{
						// "Seguir editando": back into the panel. The prompt has no trigger to return to.
						const notes = document.getElementById("order-detail-notes");
						if (notes)
						{
							e.preventDefault();
							notes.focus();
						}
					}}
				>
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
				</DialogContent>
			</Dialog>
		</>
	);
}
