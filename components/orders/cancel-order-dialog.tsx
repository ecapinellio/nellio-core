"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cancelOrder } from "@/lib/orders/actions-client";
import { FAILURE_REASONS } from "@/lib/orders/fulfillment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type ActionOutcome = "saved" | "cancelled" | "stale";

/**
 * Mounted only while open: `expectedStatus` is the status the user saw when
 * they pressed Cancelar, so a colleague's move in between gets PT409.
 */
export function CancelOrderDialog({
	orderId,
	expectedStatus,
	onDone,
}: {
	orderId: string;
	expectedStatus: string;
	onDone: (outcome: ActionOutcome) => void;
})
{
	const supabase = useMemo(() => createClient(), []);
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit()
	{
		if (!reason || (reason === "other" && !note.trim()))
		{
			setError(reason ? "Escribe cuál fue el motivo." : "Elige un motivo.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const { error: saveError } = await cancelOrder(supabase, orderId, reason, note.trim() || null, expectedStatus);
		setSubmitting(false);

		if (!saveError)
		{
			onDone("saved");
		}
		else if (saveError.code === "PT409")
		{
			onDone("stale");
		}
		else
		{
			setError(saveError.code === "22023" || saveError.code === "42501"
				? "Este pedido ya no se puede cancelar. Revisa su estado."
				: "No se pudo cancelar. Intenta de nuevo.");
		}
	}

	return (
		<Dialog open onOpenChange={(open) => { if (!open && !submitting) onDone("cancelled"); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Cancelar pedido</DialogTitle>
					<DialogDescription>El pedido sale del tablero. Esto no se puede deshacer.</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-2">
						<Label htmlFor="cancel-reason">Motivo</Label>
						<Select value={reason} onValueChange={setReason} disabled={submitting}>
							<SelectTrigger id="cancel-reason" className="w-full">
								<SelectValue placeholder="Elegir motivo" />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(FAILURE_REASONS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="cancel-note">{reason === "other" ? "Nota (obligatoria)" : "Nota (opcional)"}</Label>
						<Textarea id="cancel-note" rows={3} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} disabled={submitting} />
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
					<Button variant="destructive" className="w-full sm:w-auto" onClick={handleSubmit} disabled={submitting}>
						{submitting ? "Cancelando..." : "Cancelar pedido"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
