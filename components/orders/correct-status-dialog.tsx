"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { correctOrderStatus } from "@/lib/orders/actions-client";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";
import type { ActionOutcome } from "@/components/orders/cancel-order-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Admin only. Any destination status, with a written reason. Mounted only while open. */
export function CorrectStatusDialog({
	orderId,
	expectedStatus,
	statuses,
	hasDeliveryProof,
	onDone,
}: {
	orderId: string;
	expectedStatus: string;
	statuses: OrderStatusDef[];
	hasDeliveryProof: boolean;
	onDone: (outcome: ActionOutcome) => void;
})
{
	const supabase = useMemo(() => createClient(), []);
	const [target, setTarget] = useState("");
	const [reason, setReason] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const targetDef = statuses.find((s) => s.key === target);

	async function handleSubmit()
	{
		if (!target || !reason.trim())
		{
			setError(target ? "Escribe el motivo de la corrección." : "Elige el estado al que pasa.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const { error: saveError } = await correctOrderStatus(supabase, orderId, target, reason.trim(), expectedStatus);
		setSubmitting(false);

		if (!saveError)
		{
			onDone("saved");
		}
		else if (saveError.code === "PT409")
		{
			onDone("stale");
		}
		else if (saveError.code === "22023")
		{
			setError("No se puede hacer esta corrección (por ejemplo, el pedido ya tiene factura emitida).");
		}
		else
		{
			setError(saveError.code === "42501" ? "Solo un administrador puede corregir el estado." : "No se pudo corregir. Intenta de nuevo.");
		}
	}

	return (
		<Dialog open onOpenChange={(open) => { if (!open && !submitting) onDone("cancelled"); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Corregir estado</DialogTitle>
					<DialogDescription>Para arreglar un error. Queda en el historial con tu nombre y el motivo.</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-2">
						<Label htmlFor="correct-status">Nuevo estado</Label>
						<Select value={target} onValueChange={setTarget} disabled={submitting}>
							<SelectTrigger id="correct-status" className="w-full">
								<SelectValue placeholder="Elegir estado" />
							</SelectTrigger>
							<SelectContent>
								{statuses.filter((s) => s.key !== expectedStatus).map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
							</SelectContent>
						</Select>
						{targetDef?.category === "delivered" && !hasDeliveryProof
							? <p className="text-xs text-muted-foreground">Se marcará como entregado sin firma.</p>
							: null}
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="correct-reason">Motivo</Label>
						<Textarea id="correct-reason" rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting} />
					</div>
					{error
						? (
							<Alert variant="destructive">
								<AlertTriangle />
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)
						: null}
				</div>

				<DialogFooter>
					<Button variant="secondary" className="w-full sm:w-auto" onClick={() => onDone("cancelled")} disabled={submitting}>
						Volver
					</Button>
					<Button className="w-full sm:w-auto" onClick={handleSubmit} disabled={submitting}>
						{submitting ? "Corrigiendo..." : "Corregir"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
