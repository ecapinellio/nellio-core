"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { recordDelivery, type DriverOrder } from "@/lib/orders/actions-client";
import { describeError, GENERIC_ERROR, OFFLINE_ERROR } from "@/lib/orders/driver-orders";
import { FAILURE_REASONS } from "@/lib/orders/fulfillment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { FormPanel, FormPanelFooter, FormPanelHeader } from "@/components/form-panel";

export function FailedDeliverySheet({
	order,
	onSaved,
	onClose,
}: {
	order: DriverOrder | null;
	onSaved: (message?: string) => void;
	onClose: () => void;
})
{
	const [submitting, setSubmitting] = useState(false);

	return (
		<FormPanel open={order !== null} onOpenChange={(open) => { if (!open && !submitting) { onClose(); } }}>
			{order ? <FailedForm key={order.id} order={order} onSaved={onSaved} onClose={onClose} onSubmitting={setSubmitting} /> : null}
		</FormPanel>
	);
}

function FailedForm({
	order,
	onSaved,
	onClose,
	onSubmitting,
}: {
	order: DriverOrder;
	onSaved: (message?: string) => void;
	onClose: () => void;
	onSubmitting: (submitting: boolean) => void;
})
{
	const supabase = useMemo(() => createClient(), []);
	// Same idea as the delivery: one id per opening, reused on retry.
	const [deliveryId] = useState(() => crypto.randomUUID());
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent)
	{
		e.preventDefault();
		if (!reason || (reason === "other" && !note.trim()))
		{
			setError(reason ? "Escribe qué pasó." : "Elige un motivo.");
			return;
		}

		setSubmitting(true);
		onSubmitting(true);
		setError(null);
		try
		{
			const { error: saveError } = await recordDelivery(supabase, order.id, {
				deliveryId,
				outcome: "failed",
				lines: [],
				receiverName: null,
				signaturePath: null,
				photoPath: null,
				failureReason: reason,
				failureNote: note.trim() || null,
				paymentMethod: null,
				amountCollected: null,
			});
			if (!saveError)
			{
				onSaved();
				return;
			}
			const { message, reload } = describeError(saveError, navigator.onLine);
			if (reload)
			{
				onSaved(message);
				return;
			}
			setError(message);
		}
		catch
		{
			setError(navigator.onLine ? GENERIC_ERROR : OFFLINE_ERROR);
		}
		finally
		{
			setSubmitting(false);
			onSubmitting(false);
		}
	}

	return (
		<>
			<FormPanelHeader>
				<SheetTitle>No se pudo entregar</SheetTitle>
				<SheetDescription className="truncate">{order.customer.name}</SheetDescription>
			</FormPanelHeader>

			<form id="failed-delivery-form" onSubmit={handleSubmit} className="flex flex-col gap-4 px-4 pb-4">
				<div className="flex flex-col gap-2">
					<Label htmlFor="failure-reason">Motivo</Label>
					<Select value={reason} onValueChange={setReason} disabled={submitting}>
						<SelectTrigger id="failure-reason" className="h-11 w-full">
							<SelectValue placeholder="Elegir motivo" />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(FAILURE_REASONS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-2">
					<Label htmlFor="failure-note">Nota{reason === "other" ? "" : " (opcional)"}</Label>
					<Textarea id="failure-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} disabled={submitting} />
				</div>

				{error
					? (
						<Alert variant="destructive" role="alert">
							<AlertTriangle />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)
					: null}
			</form>

			<FormPanelFooter>
				<Button type="button" variant="secondary" className="h-11 md:h-9" onClick={onClose} disabled={submitting}>Cancelar</Button>
				<Button type="submit" form="failed-delivery-form" className="h-11 md:h-9" disabled={submitting}>
					{submitting ? <Loader2 className="animate-spin" /> : null}
					{submitting ? "Guardando…" : "Registrar"}
				</Button>
			</FormPanelFooter>
		</>
	);
}
