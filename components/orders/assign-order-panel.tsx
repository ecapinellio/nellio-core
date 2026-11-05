"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { assignOrder, listTenantDrivers, type TenantDriver } from "@/lib/orders/actions-client";
import { localDateString } from "@/lib/orders/board";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { FormPanel, FormPanelFooter, FormPanelHeader } from "@/components/form-panel";

export type AssignMode = "confirm" | "reassign" | "reprogram";

/** saved: the RPC went through. cancelled: closed without saving. stale: PT409, someone changed the order. */
export type AssignOutcome = "saved" | "cancelled" | "stale";

export interface AssignTarget
{
	id: string;
	customerName: string;
	deliveryDate: string | null;
	deliveryWindow: string | null;
}

const COPY: Record<AssignMode, { title: string; description: string; submit: string }> = {
	confirm: { title: "Confirmar pedido", description: "Elige quién lo entrega y para cuándo.", submit: "Confirmar" },
	reassign: { title: "Reasignar chofer", description: "El chofer anterior deja de ver este pedido.", submit: "Reasignar" },
	reprogram: { title: "Reprogramar entrega", description: "Elige nueva fecha, ventana y chofer.", submit: "Reprogramar" },
};

const GENERIC_ERROR = "No se pudo guardar. Intenta de nuevo.";

/**
 * Driver, date (required, today by default) and optional window for an
 * order. One panel for confirming, reassigning and reprogramming: the RPC
 * is the same, only the wording changes. `expectedStatus` is the status the
 * user saw, so the server rejects (PT409) if someone moved it meanwhile.
 */
export function AssignOrderPanel({
	order,
	mode,
	expectedStatus,
	onDone,
}: {
	order: AssignTarget | null;
	mode: AssignMode;
	expectedStatus: string;
	onDone: (outcome: AssignOutcome) => void;
})
{
	const [submitting, setSubmitting] = useState(false);

	function handleOpenChange(open: boolean)
	{
		if (!open && !submitting)
		{
			onDone("cancelled");
		}
	}

	return (
		<FormPanel open={order !== null} onOpenChange={handleOpenChange}>
			{order
				? <AssignForm key={order.id} order={order} mode={mode} expectedStatus={expectedStatus} onDone={onDone} onSubmitting={setSubmitting} />
				: null}
		</FormPanel>
	);
}

function AssignForm({
	order,
	mode,
	expectedStatus,
	onDone,
	onSubmitting,
}: {
	order: AssignTarget;
	mode: AssignMode;
	expectedStatus: string;
	onDone: (outcome: AssignOutcome) => void;
	onSubmitting: (submitting: boolean) => void;
})
{
	const supabase = useMemo(() => createClient(), []);
	const today = localDateString(new Date());
	const [drivers, setDrivers] = useState<TenantDriver[] | null>(null);
	const [driverId, setDriverId] = useState("");
	// A past date from the last attempt is never what you want for the next one.
	const [date, setDate] = useState(order.deliveryDate && order.deliveryDate >= today ? order.deliveryDate : today);
	const [timeWindow, setTimeWindow] = useState(order.deliveryWindow ?? "");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copy = COPY[mode];

	useEffect(() =>
	{
		let live = true;
		listTenantDrivers(supabase).then(({ data, error: loadError }) =>
		{
			if (!live)
			{
				return;
			}
			if (loadError || !data)
			{
				setError("No se pudieron cargar los choferes.");
				setDrivers([]);
				return;
			}
			setDrivers(data.filter((d) => d.active));
		});
		return () => { live = false; };
	}, [supabase]);

	async function handleSubmit(e: React.FormEvent)
	{
		e.preventDefault();
		if (!driverId || !date)
		{
			setError("Elige un chofer y una fecha.");
			return;
		}

		setSubmitting(true);
		onSubmitting(true);
		setError(null);
		const { error: saveError } = await assignOrder(supabase, order.id, {
			driverId,
			deliveryDate: date,
			deliveryWindow: timeWindow.trim() || null,
			expectedStatus,
		});
		setSubmitting(false);
		onSubmitting(false);

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
				? "Este pedido ya no se puede asignar así. Revisa su estado."
				: GENERIC_ERROR);
		}
	}

	return (
		<>
			<FormPanelHeader>
				<SheetTitle>{copy.title}</SheetTitle>
				<SheetDescription className="truncate">{order.customerName}. {copy.description}</SheetDescription>
			</FormPanelHeader>

			<form id="assign-order-form" onSubmit={handleSubmit} className="flex flex-col gap-4 px-4 pb-4">
				<div className="flex flex-col gap-2">
					<Label htmlFor="assign-driver">Chofer</Label>
					<Select value={driverId} onValueChange={setDriverId} disabled={submitting || drivers === null}>
						<SelectTrigger id="assign-driver" className="w-full" data-autofocus>
							<SelectValue placeholder={drivers === null ? "Cargando choferes…" : "Elegir chofer"} />
						</SelectTrigger>
						<SelectContent>
							{drivers?.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
						</SelectContent>
					</Select>
					{drivers?.length === 0 && !error
						? <p className="text-xs text-muted-foreground">No hay choferes activos. Crea uno en Administración.</p>
						: null}
				</div>

				<div className="flex flex-col gap-2">
					<Label htmlFor="assign-date">Fecha de entrega</Label>
					<Input id="assign-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={submitting} required />
				</div>

				<div className="flex flex-col gap-2">
					<Label htmlFor="assign-window">Ventana (opcional)</Label>
					<Input
						id="assign-window"
						value={timeWindow}
						onChange={(e) => setTimeWindow(e.target.value)}
						placeholder="Ej. 8:00 a 12:00"
						maxLength={80}
						disabled={submitting}
					/>
				</div>

				{error
					? (
						<Alert variant="destructive">
							<AlertTriangle />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)
					: null}
			</form>

			<FormPanelFooter>
				<Button type="button" variant="secondary" className="h-11 md:h-9" onClick={() => onDone("cancelled")} disabled={submitting}>
					Cancelar
				</Button>
				<Button type="submit" form="assign-order-form" className="h-11 md:h-9" disabled={submitting}>
					{submitting ? <Loader2 className="animate-spin" /> : null}
					{submitting ? "Guardando…" : copy.submit}
				</Button>
			</FormPanelFooter>
		</>
	);
}
