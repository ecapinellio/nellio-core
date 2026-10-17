"use client";

import type { Order } from "@/lib/supabase/queries";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface DuplicateDialogProps
{
	order: Order | null;
	onCancel: () => void;
	onConfirmNew: () => void;
}

/**
 * Required-acknowledgment dialog (eng-review decision 5): a passive banner
 * gets missed under time pressure, so a same-day pending order for this
 * customer blocks submission until the operator explicitly picks one of
 * the two actions below.
 */
export function DuplicateDialog({ order, onCancel, onConfirmNew }: DuplicateDialogProps)
{
	return (
		<Dialog open={order !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Ya existe un pedido pendiente hoy</DialogTitle>
					<DialogDescription>
						Este cliente tiene un pedido sin confirmar registrado hoy. Confirma que esto es un pedido nuevo, no un duplicado.
					</DialogDescription>
				</DialogHeader>

				{order
					? (
						<div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
							<span className="font-mono text-muted-foreground">
								{new Date(order.created_at).toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" })}
							</span>
							{" · "}
							<span className="text-muted-foreground">
								{order.notes ? `${order.notes.slice(0, 80)}${order.notes.length > 80 ? "…" : ""}` : "Sin notas"}
							</span>
						</div>
					)
					: null}

				<DialogFooter>
					<Button variant="secondary" onClick={onCancel}>Cancelar</Button>
					<Button onClick={onConfirmNew}>Es un pedido nuevo</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
