"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { OrderDetail } from "@/lib/supabase/queries";
import { formatOrderTimestamp } from "@/lib/format";
import { invalidateOrderDte } from "@/app/(app)/orders/dte-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const STATUS_LABELS: Record<string, string> = {
	queued: "Enviando a Hacienda",
	issued: "Emitida",
	rejected: "Rechazada por Hacienda",
	error: "No se pudo emitir",
	invalidated: "Invalidada",
};
const TYPE_LABELS: Record<string, string> = { "01": "Factura", "03": "Crédito fiscal" };

/**
 * The order's DTE (ADR-015): status, control number, Hacienda's seal or the
 * reason it failed. Retry (operator/admin) after fixing the data; invalidate
 * (admin) an issued one. Hidden while the order isn't delivered.
 */
export function InvoiceBlock({ detail, isAdmin, onChanged }: { detail: OrderDetail; isAdmin: boolean; onChanged: () => void })
{
	const supabase = useMemo(() => createClient(), []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [invalidating, setInvalidating] = useState(false);
	const invoice = detail.invoice;

	if (detail.invoiceStatus === "not_invoiced" && !invoice)
	{
		return null;
	}

	async function retry()
	{
		setBusy(true);
		setError(null);
		const { error: rpcError } = await supabase.rpc("retry_dte", { p_order_id: detail.id });
		setBusy(false);
		if (rpcError)
		{
			setError(rpcError.message);
			return;
		}
		onChanged();
	}

	const canRetry = invoice ? ["rejected", "error", "invalidated"].includes(invoice.status) : detail.invoiceStatus === "pending";
	const failed = invoice?.status === "rejected" || invoice?.status === "error";

	return (
		<div className="flex flex-col gap-2 border-t border-border pt-3">
			<Label>Factura electrónica</Label>
			{invoice
				? (
					<div className="flex flex-col gap-1 text-sm">
						<p className={failed ? "font-medium text-destructive" : "font-medium"}>
							{STATUS_LABELS[invoice.status]}
							{invoice.dteType ? <span className="font-normal text-muted-foreground"> · {TYPE_LABELS[invoice.dteType]}</span> : null}
						</p>
						{invoice.controlNumber ? <p className="break-all font-mono text-xs tabular-nums">{invoice.controlNumber}</p> : null}
						{invoice.receptionSeal
							? <p className="break-all font-mono text-xs text-muted-foreground">Sello {invoice.receptionSeal}{invoice.processedAt ? ` · ${formatOrderTimestamp(invoice.processedAt)}` : ""}</p>
							: null}
						{invoice.lastError ? <p className="text-xs text-destructive">{invoice.lastError}</p> : null}
						{invoice.status === "issued" || invoice.status === "invalidated"
							? <a href={`/t/${detail.trackingToken}/factura`} target="_blank" rel="noreferrer" className="text-sm text-primary underline-offset-4 hover:underline">Ver factura</a>
							: null}
					</div>
				)
				: <p className="text-sm text-muted-foreground">Pendiente: el DTE no está activado para la empresa (Empresa, en el menú).</p>}

			{canRetry || (isAdmin && invoice?.status === "issued")
				? (
					<div className="flex flex-wrap gap-2">
						{canRetry
							? (
								<Button variant="outline" className="h-11 md:h-9" onClick={retry} disabled={busy}>
									{busy ? <Loader2 className="animate-spin" /> : null}
									{invoice?.status === "invalidated" ? "Emitir de nuevo" : "Reintentar"}
								</Button>
							)
							: null}
						{isAdmin && invoice?.status === "issued"
							? <Button variant="outline" className="h-11 md:h-9" onClick={() => setInvalidating(true)}>Invalidar</Button>
							: null}
					</div>
				)
				: null}
			{error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}

			<InvalidateDialog
				open={invalidating}
				detail={detail}
				onClose={() => setInvalidating(false)}
				onDone={() =>
				{
					setInvalidating(false);
					onChanged();
				}}
			/>
		</div>
	);
}

function InvalidateDialog({ open, detail, onClose, onDone }: { open: boolean; detail: OrderDetail; onClose: () => void; onDone: () => void })
{
	const [reason, setReason] = useState("");
	const [responsibleName, setResponsibleName] = useState("");
	const [responsibleDoc, setResponsibleDoc] = useState("");
	const [requesterName, setRequesterName] = useState(detail.customerName);
	const [requesterDoc, setRequesterDoc] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent)
	{
		e.preventDefault();
		setBusy(true);
		setError(null);
		const result = await invalidateOrderDte({ orderId: detail.id, reason, responsibleName, responsibleDoc, requesterName, requesterDoc });
		setBusy(false);
		if (result.error)
		{
			setError(result.error);
			return;
		}
		onDone();
	}

	const field = (id: string, label: string, value: string, set: (v: string) => void, mono = false) => (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input id={id} value={value} onChange={(e) => set(e.target.value)} className={`h-11 md:h-9 ${mono ? "font-mono tabular-nums" : ""}`} />
		</div>
	);

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent>
				<form onSubmit={submit} noValidate className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Invalidar factura</DialogTitle>
						<DialogDescription>
							Se anula ante Hacienda (rescindir la operación). Hay plazo: 3 meses para una factura, 10 días hábiles para un crédito fiscal. No se puede deshacer.
						</DialogDescription>
					</DialogHeader>
					{field("inv-reason", "Motivo", reason, setReason)}
					{field("inv-resp", "Responsable (tu nombre)", responsibleName, setResponsibleName)}
					{field("inv-resp-doc", "DUI o NIT del responsable", responsibleDoc, setResponsibleDoc, true)}
					{field("inv-req", "Quién lo solicita", requesterName, setRequesterName)}
					{field("inv-req-doc", "DUI o NIT de quien lo solicita", requesterDoc, setRequesterDoc, true)}
					{error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
					<DialogFooter>
						<Button type="button" variant="outline" className="h-11 md:h-9" onClick={onClose}>Volver</Button>
						<Button type="submit" variant="destructive" className="h-11 md:h-9" disabled={busy}>
							{busy ? <Loader2 className="animate-spin" /> : null}Invalidar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
