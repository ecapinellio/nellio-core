"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { recordDelivery, uploadDeliveryProof, type DriverOrder } from "@/lib/orders/actions-client";
import { deliveryOutcome, initialLines, linesForRpc, validateDelivery, type DeliverySettings } from "@/lib/orders/delivery-form";
import { describeError, GENERIC_ERROR, isAlreadyUploaded, isNetworkError, OFFLINE_ERROR } from "@/lib/orders/driver-orders";
import { PAYMENT_METHODS, SHORTFALL_REASONS } from "@/lib/orders/fulfillment";
import { downscalePhoto } from "@/lib/orders/photo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { FormPanel, FormPanelFooter, FormPanelHeader } from "@/components/form-panel";
import { SignaturePad } from "@/components/deliveries/signature-pad";

/** onSaved: recorded, or the list is stale (message says why). onClose: dismissed without saving. */
export function DeliverySheet({
	order,
	settings,
	tenantId,
	onSaved,
	onClose,
}: {
	order: DriverOrder | null;
	settings: DeliverySettings;
	tenantId: string;
	onSaved: (message?: string) => void;
	onClose: () => void;
})
{
	const [submitting, setSubmitting] = useState(false);

	return (
		<FormPanel open={order !== null} onOpenChange={(open) => { if (!open && !submitting) { onClose(); } }}>
			{order
				? <DeliveryForm key={order.id} order={order} settings={settings} tenantId={tenantId} onSaved={onSaved} onClose={onClose} onSubmitting={setSubmitting} />
				: null}
		</FormPanel>
	);
}

function DeliveryForm({
	order,
	settings,
	tenantId,
	onSaved,
	onClose,
	onSubmitting,
}: {
	order: DriverOrder;
	settings: DeliverySettings;
	tenantId: string;
	onSaved: (message?: string) => void;
	onClose: () => void;
	onSubmitting: (submitting: boolean) => void;
})
{
	const supabase = useMemo(() => createClient(), []);
	// Created once per opening and reused on every retry: the server treats a repeat as a no-op.
	// A changed proof rotates it (see changeProof).
	const [firstId] = useState(() => crypto.randomUUID());
	const proofs = useRef({ deliveryId: firstId, uploaded: {} as { signature?: string; photo?: string } });
	const [lines, setLines] = useState(() => initialLines(order.items));
	const [receiverName, setReceiverName] = useState("");
	const [signature, setSignature] = useState<Blob | null>(null);
	const [photo, setPhoto] = useState<Blob | null>(null);
	const [paymentMethod, setPaymentMethod] = useState("");
	const [amount, setAmount] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);

	// Proofs are immutable at their path: if one changes after anything was
	// uploaded, start over under a new id so both go up fresh. Safe: if the
	// earlier attempt had saved, the order is no longer picked up and the
	// server rejects the retry.
	function changeProof()
	{
		if (proofs.current.uploaded.signature || proofs.current.uploaded.photo)
		{
			proofs.current.deliveryId = crypto.randomUUID();
			proofs.current.uploaded = {};
		}
	}

	const outcome = deliveryOutcome(lines);

	function setLine(index: number, change: Partial<typeof lines[number]>)
	{
		setLines((current) => current.map((l, i) => (i === index ? { ...l, ...change } : l)));
	}

	async function pickPhoto(file: File | undefined)
	{
		if (!file)
		{
			return;
		}
		try
		{
			changeProof();
			setPhoto(await downscalePhoto(file));
		}
		catch
		{
			setErrors(["No se pudo leer la foto. Toma otra."]);
		}
	}

	/** Returns the stored path, or a message to show. */
	async function ensureProof(kind: "signature" | "photo", blob: Blob | null): Promise<{ path: string | null; failure?: string }>
	{
		if (!blob)
		{
			return { path: null };
		}
		if (proofs.current.uploaded[kind])
		{
			return { path: proofs.current.uploaded[kind]! };
		}
		const { data, error } = await uploadDeliveryProof(supabase, tenantId, proofs.current.deliveryId, kind, blob);
		if (error && !isAlreadyUploaded(error.message))
		{
			return { path: null, failure: isNetworkError(error.message, navigator.onLine) ? OFFLINE_ERROR : GENERIC_ERROR };
		}
		// "Already exists" = our own earlier upload (a changed proof rotated the id).
		const path = data ?? `${tenantId}/${proofs.current.deliveryId}/${kind === "signature" ? "signature.png" : "photo.jpg"}`;
		proofs.current.uploaded[kind] = path;
		return { path };
	}

	async function handleSubmit(e: React.FormEvent)
	{
		e.preventDefault();
		const problems = validateDelivery({ lines, receiverName, hasSignature: signature !== null, hasPhoto: photo !== null, paymentMethod, amount }, settings);
		if (problems.length > 0)
		{
			setErrors(problems);
			return;
		}

		setSubmitting(true);
		onSubmitting(true);
		setErrors([]);
		try
		{
			const sig = await ensureProof("signature", signature);
			const pic = sig.failure ? sig : await ensureProof("photo", photo);
			if (sig.failure || pic.failure)
			{
				setErrors([sig.failure ?? pic.failure!]);
				return;
			}

			const { error } = await recordDelivery(supabase, order.id, {
				deliveryId: proofs.current.deliveryId,
				outcome: "delivered",
				lines: linesForRpc(lines),
				receiverName: receiverName.trim() || null,
				signaturePath: sig.path,
				photoPath: pic.path,
				failureReason: null,
				failureNote: null,
				paymentMethod: paymentMethod || null,
				amountCollected: amount.trim() ? Number(amount) : null,
			});
			if (!error)
			{
				onSaved();
				return;
			}
			const { message, reload } = describeError(error, navigator.onLine);
			if (reload)
			{
				onSaved(message);
				return;
			}
			setErrors([message]);
		}
		catch
		{
			// fetch rejects with a TypeError when there is no signal.
			setErrors([navigator.onLine ? GENERIC_ERROR : OFFLINE_ERROR]);
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
				<SheetTitle>Entregar pedido</SheetTitle>
				<SheetDescription className="truncate">{order.customer.name}</SheetDescription>
			</FormPanelHeader>

			<form id="delivery-form" onSubmit={handleSubmit} className="flex flex-col gap-4 px-4 pb-4">
				<div className="flex flex-col gap-3">
					<Label>Productos entregados</Label>
					{lines.map((line, index) => (
						<div key={line.orderItemId} className="flex flex-col gap-2 rounded-md border border-border p-3">
							<div className="flex items-center justify-between gap-3">
								<span className="min-w-0 text-sm font-medium">{line.productName}</span>
								<div className="flex shrink-0 items-center gap-2">
									<Input
										aria-label={`Cantidad entregada de ${line.productName}`}
										inputMode="decimal"
										value={line.delivered}
										onChange={(e) => setLine(index, { delivered: e.target.value, reason: "" })}
										disabled={submitting}
										className="h-11 w-20 text-right font-mono tabular-nums"
									/>
									<span className="font-mono text-sm text-muted-foreground tabular-nums">de {line.ordered}{line.unit ? ` ${line.unit}` : ""}</span>
								</div>
							</div>
							{Number(line.delivered) < line.ordered || line.delivered.trim() === ""
								? (
									<Select value={line.reason} onValueChange={(reason) => setLine(index, { reason })} disabled={submitting}>
										<SelectTrigger className="h-11 w-full" aria-label={`Motivo de ${line.productName}`}>
											<SelectValue placeholder="¿Por qué no se entregó todo?" />
										</SelectTrigger>
										<SelectContent>
											{Object.entries(SHORTFALL_REASONS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
										</SelectContent>
									</Select>
								)
								: null}
						</div>
					))}
				</div>

				<div className="flex flex-col gap-2">
					<Label htmlFor="receiver-name">Quién recibe{settings.require_receiver_name ? "" : " (opcional)"}</Label>
					<Input id="receiver-name" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} maxLength={200} disabled={submitting} className="h-11" />
				</div>

				<div className="flex flex-col gap-2">
					<Label>Firma{settings.require_signature ? "" : " (opcional)"}</Label>
					<SignaturePad
						onChange={(blob) =>
						{
							changeProof();
							setSignature(blob);
						}}
					/>
				</div>

				<div className="flex flex-col gap-2">
					<Label htmlFor="delivery-photo">Foto{settings.require_photo ? "" : " (opcional)"}</Label>
					<Button type="button" variant="secondary" className="h-11 self-start" asChild>
						<label htmlFor="delivery-photo">
							<Camera />
							{photo ? "Cambiar foto" : "Tomar foto"}
						</label>
					</Button>
					<input
						id="delivery-photo"
						type="file"
						accept="image/*"
						capture="environment"
						className="sr-only"
						disabled={submitting}
						onChange={(e) => pickPhoto(e.target.files?.[0])}
					/>
					{photo ? <p className="text-xs text-muted-foreground">Foto lista.</p> : null}
				</div>

				<div className="grid grid-cols-2 gap-3">
					<div className="flex flex-col gap-2">
						<Label htmlFor="payment-method">Método de cobro</Label>
						<Select value={paymentMethod || "none"} onValueChange={(v) => setPaymentMethod(v === "none" ? "" : v)} disabled={submitting}>
							<SelectTrigger id="payment-method" className="h-11 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">Sin cobro</SelectItem>
								{Object.entries(PAYMENT_METHODS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="amount">Monto cobrado</Label>
						<Input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={submitting} className="h-11 font-mono tabular-nums" />
					</div>
				</div>

				{errors.length > 0
					? (
						<Alert variant="destructive" role="alert">
							<AlertTriangle />
							<AlertDescription>
								{errors.map((message) => <p key={message}>{message}</p>)}
							</AlertDescription>
						</Alert>
					)
					: null}
			</form>

			<FormPanelFooter>
				<Button type="button" variant="secondary" className="h-11 md:h-9" onClick={onClose} disabled={submitting}>Cancelar</Button>
				<Button type="submit" form="delivery-form" className="h-11 md:h-9" disabled={submitting}>
					{submitting ? <Loader2 className="animate-spin" /> : null}
					{submitting ? "Guardando…" : outcome === "partially_delivered" ? "Entrega parcial" : "Confirmar entrega"}
				</Button>
			</FormPanelFooter>
		</>
	);
}
