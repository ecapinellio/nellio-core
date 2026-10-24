"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { createOperatorOrDriver, type CreatableRole, type Credentials } from "@/app/(app)/admin/users/actions";
import { ROLE_LABELS } from "@/lib/users/role-labels";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

const GENERIC_ERROR = "No se pudo crear el usuario. Intenta de nuevo.";

/**
 * "+ Agregar usuario" and its form (design review D1). On success it closes
 * and hands the credentials up — the shared OneTimePasswordDialog shows
 * them, same as for restore/reactivate.
 */
export function CreateUserDialog({ onCreated }: { onCreated: (credentials: Credentials) => void })
{
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	// Slice 2 design Decision 16: no default — the role sets permissions, so
	// it has to be a deliberate choice.
	const [role, setRole] = useState<CreatableRole | "">("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function handleOpenChange(next: boolean)
	{
		if (submitting)
		{
			return;
		}
		setOpen(next);
		if (next)
		{
			setName("");
			setEmail("");
			setRole("");
			setError(null);
		}
	}

	async function handleSubmit(e: React.FormEvent)
	{
		e.preventDefault();

		const trimmedName = name.trim();
		const trimmedEmail = email.trim();

		if (!trimmedName || !trimmedEmail || !role)
		{
			setError("Completa nombre, correo y rol.");
			return;
		}

		setSubmitting(true);
		setError(null);

		// The action returns errors as values, but a dropped connection or a
		// server crash throws — without this the button stays on "Creando…"
		// forever and the admin can't retry.
		let result: Awaited<ReturnType<typeof createOperatorOrDriver>>;
		try
		{
			result = await createOperatorOrDriver({ name: trimmedName, email: trimmedEmail, role });
		}
		catch
		{
			result = { data: null, error: null };
		}
		finally
		{
			setSubmitting(false);
		}

		if (result.error || !result.data)
		{
			// Values stay (slice 2 Decision 17) — the error likely wasn't the
			// admin's fault (e.g. a cross-tenant email collision).
			setError(result.error ?? GENERIC_ERROR);
			return;
		}

		setOpen(false);
		onCreated(result.data);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button>
					<Plus />
					Agregar usuario
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Agregar usuario</DialogTitle>
					<DialogDescription>Le generaremos una contraseña que verás una sola vez.</DialogDescription>
				</DialogHeader>

				<form id="create-user-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="name">Nombre</Label>
						<Input id="name" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} autoFocus />
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="email">Correo</Label>
						<Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} />
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="role">Rol</Label>
						<Select value={role} onValueChange={(v) => setRole(v as CreatableRole)} disabled={submitting}>
							<SelectTrigger id="role" className="w-full">
								<SelectValue placeholder="Elegir rol" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="operator">{ROLE_LABELS.operator}</SelectItem>
								<SelectItem value="driver">{ROLE_LABELS.driver}</SelectItem>
							</SelectContent>
						</Select>
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

				<DialogFooter>
					<Button type="button" variant="secondary" onClick={() => handleOpenChange(false)} disabled={submitting}>
						Cancelar
					</Button>
					<Button type="submit" form="create-user-form" disabled={submitting}>
						{submitting ? <Loader2 className="animate-spin" /> : null}
						{submitting ? "Creando…" : "Crear usuario"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
