"use client";

import type { SaveConflict } from "@/lib/products/catalog";
import { UNIT_LABELS, isProductUnit } from "@/lib/products/units";
import type { GridRow } from "@/lib/products/grid";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export type ConflictChoice = "theirs" | "mine";

/**
 * Someone saved a product after this grid loaded it (eng review D5, design
 * D12): a blocking dialog, because nothing in the batch saves until every
 * conflict is decided. Shows who, when, what it is now, and what you typed.
 */
export function ConflictDialog({
	conflicts,
	rows,
	choices,
	onChoose,
	onChooseAll,
	onCancel,
}: {
	conflicts: SaveConflict[] | null;
	rows: GridRow[];
	choices: Record<string, ConflictChoice>;
	onChoose: (id: string, choice: ConflictChoice) => void;
	onChooseAll: (choice: ConflictChoice) => void;
	onCancel: () => void;
})
{
	const list = conflicts ?? [];

	return (
		<Dialog open={conflicts !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{list.length === 1 ? "1 producto cambió mientras editabas" : `${list.length} productos cambiaron mientras editabas`}
					</DialogTitle>
					<DialogDescription>
						No se guardó nada todavía. Elige qué versión queda en cada uno.
					</DialogDescription>
				</DialogHeader>

				<ul className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
					{list.map((c) =>
					{
						const mine = rows.find((r) => r.id === c.id);
						const who = c.updated_by_name ?? "Otra persona";
						const choice = choices[c.id];
						return (
							<li key={c.id} className="rounded-md border border-border p-3">
								<p className="text-sm font-semibold">{c.name}</p>
								<p className="text-xs text-muted-foreground">{who} · {formatWhen(c.updated_at)}</p>
								<dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-sm">
									<dt className="text-muted-foreground">Ahora</dt>
									<dd className="font-mono tabular-nums">{describe(c.name, c.price_per_unit?.toFixed(2) ?? "", c.unit, c.active)}</dd>
									<dt className="text-muted-foreground">Tu cambio</dt>
									<dd className="font-mono tabular-nums">{mine ? describe(mine.name, mine.price, mine.unit, mine.active) : "—"}</dd>
								</dl>
								<div className="mt-2 flex flex-wrap gap-2">
									<Button
										type="button"
										size="sm"
										variant={choice === "theirs" ? "default" : "outline"}
										aria-pressed={choice === "theirs"}
										onClick={() => onChoose(c.id, "theirs")}
									>
										{c.updated_by_name ? `Usar el de ${firstName(c.updated_by_name)}` : "Usar el guardado"}
									</Button>
									<Button
										type="button"
										size="sm"
										variant={choice === "mine" ? "default" : "outline"}
										aria-pressed={choice === "mine"}
										onClick={() => onChoose(c.id, "mine")}
									>
										Guardar el mío
									</Button>
								</div>
							</li>
						);
					})}
				</ul>

				<DialogFooter className="sm:justify-between">
					{list.length > 1
						? (
							<div className="flex gap-2">
								<Button type="button" variant="ghost" size="sm" onClick={() => onChooseAll("theirs")}>Usar todos los de ellos</Button>
								<Button type="button" variant="ghost" size="sm" onClick={() => onChooseAll("mine")}>Guardar todos los míos</Button>
							</div>
						)
						: <span />}
					<Button type="button" variant="secondary" onClick={onCancel}>Volver a la tabla</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function describe(name: string, price: string, unit: string | null, active: boolean): string
{
	const unitLabel = unit && isProductUnit(unit) ? UNIT_LABELS[unit] : "sin unidad";
	const priceText = price ? `$${price}` : "sin precio";
	return `${name} · ${priceText} · ${unitLabel}${active ? "" : " · desactivado"}`;
}

function firstName(name: string): string
{
	return name.split(" ")[0] ?? name;
}

function formatWhen(iso: string): string
{
	const date = new Date(iso);
	const minutes = Math.round((Date.now() - date.getTime()) / 60000);
	const time = date.toLocaleTimeString("es-SV", { hour: "2-digit", minute: "2-digit" });
	if (minutes < 1)
	{
		return `hace un momento (${time})`;
	}
	if (minutes < 60)
	{
		return `hace ${minutes} min (${time})`;
	}
	return date.toLocaleString("es-SV", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
