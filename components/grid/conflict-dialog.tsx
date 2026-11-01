"use client";

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

/** What every save RPC returns for a row someone else saved meanwhile. */
export interface GridConflict
{
	id: string;
	name: string;
	updated_at: string;
	updated_by_name: string | null;
}

/**
 * Someone saved a row after this grid loaded it (catalog eng review D5,
 * design D12): a blocking dialog, because nothing in the batch saves until
 * every conflict is decided. Shows who, when, what it is now, and what you
 * typed — the entity says how to describe each side.
 */
export function ConflictDialog<K extends GridConflict>({
	conflicts,
	nouns,
	describeTheirs,
	describeMine,
	choices,
	onChoose,
	onChooseAll,
	onCancel,
}: {
	conflicts: K[] | null;
	/** "producto" / "productos" — for the title. */
	nouns: { one: string; many: string };
	describeTheirs: (conflict: K) => string;
	/** null when the row isn't in the grid anymore. */
	describeMine: (id: string) => string | null;
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
						{list.length === 1 ? `1 ${nouns.one} cambió mientras editabas` : `${list.length} ${nouns.many} cambiaron mientras editabas`}
					</DialogTitle>
					<DialogDescription>
						No se guardó nada todavía. Elige qué versión queda en cada uno.
					</DialogDescription>
				</DialogHeader>

				<ul className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
					{list.map((c) =>
					{
						const mine = describeMine(c.id);
						const who = c.updated_by_name ?? "Otra persona";
						const choice = choices[c.id];
						return (
							<li key={c.id} className="rounded-md border border-border p-3">
								<p className="text-sm font-semibold">{c.name}</p>
								<p className="text-xs text-muted-foreground">{who} · {formatWhen(c.updated_at)}</p>
								<dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-sm">
									<dt className="text-muted-foreground">Ahora</dt>
									<dd className="font-mono tabular-nums">{describeTheirs(c)}</dd>
									<dt className="text-muted-foreground">Tu cambio</dt>
									<dd className="font-mono tabular-nums">{mine ?? "—"}</dd>
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
