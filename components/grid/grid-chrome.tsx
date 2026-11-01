"use client";

import { AlertTriangle, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { GridToast, PastePrompt } from "@/components/grid/use-editable-grid";

/** Search, the entity's "incomplete" chip, "Mostrar desactivados" and "Ver todos". */
export function GridToolbar({
	search,
	onSearch,
	searchLabel,
	incomplete,
	showInactive,
	onShowInactive,
	onlyProblems,
	onShowAll,
}: {
	search: string;
	onSearch: (value: string) => void;
	searchLabel: string;
	/** Hidden when count is 0. */
	incomplete: { label: string; count: number; on: boolean; toggle: () => void };
	showInactive: boolean;
	onShowInactive: (value: boolean) => void;
	onlyProblems: boolean;
	onShowAll: () => void;
})
{
	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="relative w-full sm:w-72">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				<input
					type="search"
					value={search}
					onChange={(e) => onSearch(e.target.value)}
					placeholder={`${searchLabel}…`}
					aria-label={searchLabel}
					className="h-11 w-full rounded-md border border-input bg-transparent pr-3 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9"
				/>
			</div>
			{incomplete.count > 0
				? (
					<Button
						type="button"
						variant={incomplete.on ? "default" : "outline"}
						size="sm"
						aria-pressed={incomplete.on}
						onClick={incomplete.toggle}
						className="h-11 md:h-8"
					>
						{incomplete.label} · <span className="font-mono tabular-nums">{incomplete.count}</span>
					</Button>
				)
				: null}
			<label className="flex h-11 items-center gap-2 px-1 text-sm md:h-8">
				<input type="checkbox" checked={showInactive} onChange={(e) => onShowInactive(e.target.checked)} className="size-4 accent-primary" />
				Mostrar desactivados
			</label>
			{onlyProblems
				? <Button type="button" variant="ghost" size="sm" onClick={onShowAll} className="h-11 md:h-8">Ver todos</Button>
				: null}
		</div>
	);
}

/** Sticky bottom bar, only while there are changes (catalog design D4 / 1A). */
export function SaveBar({
	newCount,
	editedCount,
	problemCount,
	saving,
	saveError,
	saveCount,
	onShowProblems,
	onDiscard,
	onSave,
}: {
	newCount: number;
	editedCount: number;
	problemCount: number;
	saving: boolean;
	saveError: string | null;
	saveCount: number;
	onShowProblems: () => void;
	onDiscard: () => void;
	onSave: () => void;
})
{
	return (
		<div className="sticky bottom-0 z-10 -mx-4 hidden border-t border-border bg-background px-4 py-3 shadow-sm md:-mx-6 md:block md:px-6">
			{saveError
				? (
					<Alert variant="destructive" className="mb-2">
						<AlertTriangle />
						<AlertDescription>{saveError}</AlertDescription>
					</Alert>
				)
				: null}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm">
					{[newCount ? `${newCount} ${newCount === 1 ? "nuevo" : "nuevos"}` : null, editedCount ? `${editedCount} ${editedCount === 1 ? "editado" : "editados"}` : null].filter(Boolean).join(" · ")}
					{problemCount > 0
						? (
							<>
								{" · "}
								<button type="button" onClick={onShowProblems} className="font-medium text-destructive underline-offset-4 hover:underline">
									{problemCount === 1 ? "1 con problemas" : `${problemCount} con problemas`}
								</button>
							</>
						)
						: null}
				</p>
				<div className="flex gap-2">
					<Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>Descartar</Button>
					<Button type="button" onClick={onSave} disabled={saving}>
						{saving ? <><Loader2 className="animate-spin" />Guardando…</> : `Guardar ${saveCount}`}
					</Button>
				</div>
			</div>
		</div>
	);
}

/** Paste summary / save result, announced to screen readers. */
export function GridToastView({ toast, onShowProblems }: { toast: GridToast | null; onShowProblems: () => void })
{
	return (
		<div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-24 z-20 flex justify-end md:bottom-20">
			{toast
				? (
					<div key={toast.id} className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm shadow-md">
						<span>{toast.text}</span>
						{toast.showProblems
							? <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onShowProblems}>Ver</Button>
							: null}
					</div>
				)
				: null}
		</div>
	);
}

/** Pasting names over saved rows would rename them — old orders show the current name. */
export function PasteRenameDialog<C>({
	prompt,
	nouns,
	onReplace,
	onAddNew,
	onCancel,
}: {
	prompt: PastePrompt<C> | null;
	nouns: { one: string; many: string };
	onReplace: (prompt: PastePrompt<C>) => void;
	onAddNew: (prompt: PastePrompt<C>) => void;
	onCancel: () => void;
})
{
	return (
		<Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						¿Cambiar el nombre de {prompt?.renamed === 1 ? `1 ${nouns.one} que ya existe` : `${prompt?.renamed} ${nouns.many} que ya existen`}?
					</DialogTitle>
					<DialogDescription>
						Pegaste sobre {nouns.many} guardados. Los pedidos anteriores mostrarán el nombre nuevo.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => { if (prompt) onReplace(prompt); }}>
						Reemplazar nombres
					</Button>
					<Button type="button" onClick={() => { if (prompt) onAddNew(prompt); }}>
						Agregar como nuevos
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function EmptyFilter({ search, noun, onClear }: { search: string; noun: string; onClear: () => void })
{
	return (
		<div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
			<p>{search ? `Ningún ${noun} coincide con ‘${search}’.` : `Ningún ${noun} coincide con el filtro.`}</p>
			<Button type="button" variant="outline" size="sm" onClick={onClear}>Limpiar búsqueda</Button>
		</div>
	);
}
