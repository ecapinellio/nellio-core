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
} from "@/lib/supabase/queries";
import { EntitySearch } from "@/components/capture/entity-search";
import { LineItems, type LineItem } from "@/components/capture/line-items";
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

	const canSubmit = customer !== null && items.length > 0 && notes.trim().length > 0 && !submitting;

	function addItem(productId: string, productName: string)
	{
		setItems((prev) =>
		{
			const existing = prev.find((i) => i.productId === productId);
			if (existing)
			{
				return prev.map((i) => (i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i));
			}
			return [...prev, { productId, productName, quantity: 1 }];
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

	async function doCreate()
	{
		if (!customer)
		{
			return;
		}
		setSubmitting(true);
		const { data, error: createError } = await createOrder(supabase, {
			customer_id: customer.id,
			notes,
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
		<div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
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
						/>
					</CardContent>
				</Card>
			</div>

			<div className="flex flex-col gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Mensaje original</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-2">
							<Label htmlFor="notes">Pega o transcribe el mensaje de WhatsApp</Label>
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
