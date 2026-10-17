"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
	checkPendingDuplicateOrder,
	createOrder,
	quickAddCustomer,
	searchCustomers,
	type Customer,
	type Order,
	type ProductUnit,
} from "@/lib/supabase/queries";
import { EntitySearch } from "@/components/capture/entity-search";
import { LineItems, type LineItem } from "@/components/capture/line-items";
import { OrderOverview } from "@/components/capture/order-overview";
import { DuplicateDialog } from "@/components/capture/duplicate-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface FormError
{
	kind: "session" | "generic";
	message: string;
}

export function CaptureForm()
{
	const supabase = useMemo(() => createClient(), []);

	const [customer, setCustomer] = useState<Customer | null>(null);
	const [items, setItems] = useState<LineItem[]>([]);
	const [notes, setNotes] = useState("");

	const [submitting, setSubmitting] = useState(false);
	const [duplicateOrder, setDuplicateOrder] = useState<Order | null>(null);
	const [failOpen, setFailOpen] = useState(false);
	const [error, setError] = useState<FormError | null>(null);
	const [success, setSuccess] = useState<{ orderId: string } | null>(null);

	// Slice 2, Decision 3: notes is optional — dropped from canSubmit.
	const canSubmit = customer !== null && items.length > 0 && !submitting;

	function addItem(productId: string, productName: string, pricePerUnit: number | null, unit: ProductUnit | null)
	{
		setItems((prev) =>
		{
			const existing = prev.find((i) => i.productId === productId);
			if (existing)
			{
				return prev.map((i) => (i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i));
			}
			return [...prev, { productId, productName, quantity: 1, pricePerUnit, unit }];
		});
	}

	function updateQuantity(productId: string, quantity: number)
	{
		setItems((prev) => prev.map((i) => (i.productId === productId ? { ...i, quantity } : i)));
	}

	function removeItem(productId: string)
	{
		setItems((prev) => prev.filter((i) => i.productId !== productId));
	}

	// Slice 2, Decision 5: quick-add never collects price up front — this is
	// the inline "+ precio" flow filling it in after the fact.
	function updatePrice(productId: string, pricePerUnit: number, unit: ProductUnit)
	{
		setItems((prev) => prev.map((i) => (i.productId === productId ? { ...i, pricePerUnit, unit } : i)));
	}

	async function doCreate()
	{
		if (!customer)
		{
			return;
		}
		setSubmitting(true);
		const { data, error: createError } = await createOrder(supabase, {
			customer_id: customer.id,
			notes: notes.trim() || null,
			items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
			channel: "whatsapp",
		});
		setSubmitting(false);

		if (createError)
		{
			if (createError.code === "28000" || createError.message?.includes("JWT expired"))
			{
				setError({ kind: "session", message: "Tu sesión expiró." });
			}
			else
			{
				setError({ kind: "generic", message: createError.message || "No se pudo guardar el pedido." });
			}
			return;
		}

		setSuccess({ orderId: data!.order.id });
		setCustomer(null);
		setItems([]);
		setNotes("");
	}

	async function handleSubmit()
	{
		if (!canSubmit || !customer)
		{
			return;
		}
		setError(null);
		setSuccess(null);
		setFailOpen(false);
		setSubmitting(true);

		const dup = await checkPendingDuplicateOrder(supabase, customer.id);

		if (dup.status === "check_failed")
		{
			setFailOpen(true);
			await doCreate();
			return;
		}

		if (dup.duplicate)
		{
			setDuplicateOrder(dup.duplicate);
			setSubmitting(false);
			return;
		}

		await doCreate();
	}

	function handleCancelDuplicate()
	{
		setDuplicateOrder(null);
		setSubmitting(false);
	}

	function handleConfirmDuplicate()
	{
		setDuplicateOrder(null);
		doCreate();
	}

	return (
		<div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
			{/* Left column: entry form — everything the operator fills in. */}
			<div className="flex flex-col gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Cliente</CardTitle>
					</CardHeader>
					<CardContent>
						{customer
							? (
								<div className="flex items-center justify-between rounded-md border border-accent-foreground/20 bg-accent px-3 py-2">
									<span className="text-sm font-semibold text-accent-foreground">{customer.name}</span>
									<button
										type="button"
										onClick={() => setCustomer(null)}
										aria-label="Cambiar cliente"
										className="text-muted-foreground hover:text-foreground"
									>
										<X className="size-4" />
									</button>
								</div>
							)
							: (
								<EntitySearch
									supabase={supabase}
									placeholder="Buscar o agregar cliente..."
									searchFn={searchCustomers}
									quickAddFn={quickAddCustomer}
									getLabel={(c) => c.name}
									getId={(c) => c.id}
									quickAddNoun="cliente"
									onSelect={setCustomer}
									autoFocus
								/>
							)}
					</CardContent>
				</Card>

				<Card>
					<CardContent>
						<LineItems
							supabase={supabase}
							items={items}
							onAdd={addItem}
							onQuantityChange={updateQuantity}
							onRemove={removeItem}
							onPriceUpdate={updatePrice}
						/>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Notas</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-2">
							<Label htmlFor="notes">Opcional — mensaje original, contexto, lo que haga falta</Label>
							<Textarea
								id="notes"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								rows={6}
								placeholder="hola! necesito 12 bidones de..."
								className="font-mono text-xs"
							/>
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Right column: live, sticky overview — Decision 1, standard
			    checkout-UX pattern (form left, summary + submit right).
			    Sticky on this whole group, not the individual cards, so the
			    offset stays correct regardless of either card's height. */}
			<div className="sticky top-6 flex flex-col gap-4">
				<OrderOverview customer={customer} items={items} />

				<Card>
					<CardContent className="flex flex-col gap-3">
						{failOpen
							? (
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertDescription>No se pudo verificar duplicados. Verifica manualmente antes de confirmar.</AlertDescription>
								</Alert>
							)
							: null}

						{error
							? (
								<Alert variant="destructive">
									<AlertTriangle />
									<AlertDescription>
										{error.message}
										{error.kind === "session"
											? <> <Link href="/login" className="underline">Volver a iniciar sesión</Link></>
											: null}
									</AlertDescription>
								</Alert>
							)
							: null}

						{success
							? (
								<Alert style={{ color: "var(--status-delivered)" }}>
									<CheckCircle2 />
									<AlertDescription>Pedido guardado ({success.orderId.slice(0, 8)}).</AlertDescription>
								</Alert>
							)
							: null}

						<Button onClick={handleSubmit} disabled={!canSubmit} className="w-full justify-center">
							{submitting ? "Guardando..." : "Guardar pedido"}
						</Button>
					</CardContent>
				</Card>
			</div>

			<DuplicateDialog
				order={duplicateOrder}
				onCancel={handleCancelDuplicate}
				onConfirmNew={handleConfirmDuplicate}
			/>
		</div>
	);
}
