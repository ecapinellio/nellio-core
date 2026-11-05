import { formatOrderTimestamp } from "@/lib/format";
import { reasonLabel } from "@/lib/orders/detail";
import { PAYMENT_METHODS, SHORTFALL_REASONS } from "@/lib/orders/fulfillment";
import type { OrderDetail } from "@/lib/supabase/queries";

function Row({ label, children }: { label: string; children: React.ReactNode })
{
	return (
		<div className="flex justify-between gap-3 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="text-right">{children}</span>
		</div>
	);
}

/** What the driver recorded at the door, plus lines delivered short. Renders nothing before any delivery. */
export function DeliveryProof({ detail }: { detail: OrderDetail })
{
	const { delivery, items, events } = detail;
	// Latest event decides: a correction to delivered with no recorded delivery.
	const unsigned = events.at(-1)?.withoutSignature === true;
	const short = items.filter((i) => i.deliveredQuantity !== null && i.deliveredQuantity < i.quantity);

	if (!delivery && !unsigned)
	{
		return null;
	}

	return (
		<div className="flex flex-col gap-2 border-t border-border pt-3">
			<span className="text-sm font-medium">Entrega</span>
			{unsigned ? <p className="text-sm font-medium">Entregado sin firma</p> : null}

			{delivery?.outcome === "failed"
				? (
					<>
						<Row label="Hora">{formatOrderTimestamp(delivery.createdAt)}</Row>
						{delivery.failureReason ? <Row label="Motivo">{reasonLabel(delivery.failureReason)}</Row> : null}
						{delivery.failureNote ? <Row label="Nota">{delivery.failureNote}</Row> : null}
					</>
				)
				: delivery
					? (
						<>
							{delivery.receiverName ? <Row label="Recibió">{delivery.receiverName}</Row> : null}
							<Row label="Hora"><span className="font-mono text-xs tabular-nums">{formatOrderTimestamp(delivery.createdAt)}</span></Row>
							{delivery.paymentMethod ? <Row label="Cobro">{PAYMENT_METHODS[delivery.paymentMethod] ?? delivery.paymentMethod}</Row> : null}
							{delivery.amountCollected !== null
								? <Row label="Monto cobrado"><span className="font-mono tabular-nums">${delivery.amountCollected.toFixed(2)}</span></Row>
								: null}
							{delivery.signatureUrl || delivery.photoUrl
								? (
									<div className="flex flex-wrap gap-3 pt-1">
										{delivery.signatureUrl
											? <ProofImage src={delivery.signatureUrl} alt="Firma de quien recibió" caption="Firma" />
											: null}
										{delivery.photoUrl
											? <ProofImage src={delivery.photoUrl} alt="Foto de la entrega" caption="Foto" />
											: null}
									</div>
								)
								: null}
						</>
					)
					: null}

			{short.length > 0
				? (
					<ul className="flex flex-col gap-1 pt-1">
						{short.map((i) => (
							<li key={i.id} className="text-sm">
								{i.productName}: <span className="font-mono tabular-nums">entregó {i.deliveredQuantity} de {i.quantity}</span>
								{i.shortfallReason ? ` · ${SHORTFALL_REASONS[i.shortfallReason] ?? i.shortfallReason}` : ""}
								{i.shortfallNote ? <span className="text-muted-foreground"> ({i.shortfallNote})</span> : null}
							</li>
						))}
					</ul>
				)
				: null}
		</div>
	);
}

function ProofImage({ src, alt, caption }: { src: string; alt: string; caption: string })
{
	return (
		<a href={src} target="_blank" rel="noreferrer" className="flex flex-col gap-1">
			{/* Signed storage URL: next/image would need the host configured for a 1 h link. */}
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={src} alt={alt} className="h-24 w-auto rounded-sm border border-border bg-white object-contain" />
			<span className="text-xs text-muted-foreground">{caption}</span>
		</a>
	);
}
