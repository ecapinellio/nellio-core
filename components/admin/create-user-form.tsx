"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { createOperatorOrDriver, type CreatableRole } from "@/app/(app)/admin/users/actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface CreatedUser
{
	email: string;
	password: string;
	role: CreatableRole;
}

const ROLE_LABELS: Record<CreatableRole, string> = {
	operator: "Operador",
	driver: "Driver",
};

const LEAVE_WARNING =
	"No copiaste la contraseña generada. Si salís de esta página se pierde para siempre. ¿Salir de todas formas?";

/**
 * Design review Decision 19 (non-negotiable): the generated password is
 * shown exactly once and never stored — if the admin leaves this page
 * before copying it, it's gone for good (no user-list view exists yet to
 * recover it from). This guard covers desktop tab-close/reload
 * (beforeunload) AND in-app navigation on every device, including mobile
 * where beforeunload is unreliable — a capture-phase click listener on
 * any <a> intercepts navigation (e.g. a sidebar link) and confirms first,
 * and a capture-phase submit listener does the same for forms (the
 * header's "Cerrar sesión" is a Server Action form, not a link, and its
 * redirect never fires beforeunload). Clears permanently once `copied` is
 * true.
 */
function useLeaveGuard(active: boolean)
{
	const router = useRouter();

	useEffect(() =>
	{
		if (!active)
		{
			return;
		}

		function handleBeforeUnload(e: BeforeUnloadEvent)
		{
			e.preventDefault();
			e.returnValue = "";
		}

		function handleClick(e: MouseEvent)
		{
			// Modified/middle clicks and target=_blank open a new tab — this
			// page (and the password) stays put, so there's nothing to guard.
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
			{
				return;
			}
			const target = e.target as HTMLElement;
			const anchor = target.closest("a");
			if (!anchor || anchor.target === "_blank")
			{
				return;
			}
			const href = anchor.getAttribute("href");
			if (!href || href.startsWith("#"))
			{
				return;
			}
			const leaveAnyway = window.confirm(LEAVE_WARNING);
			if (!leaveAnyway)
			{
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Already confirmed — perform the navigation ourselves since
			// preventDefault() on this capture-phase listener would otherwise
			// have blocked it for everyone (it's the same listener).
			e.preventDefault();
			e.stopPropagation();
			router.push(href);
		}

		function handleSubmit(e: SubmitEvent)
		{
			if (!window.confirm(LEAVE_WARNING))
			{
				e.preventDefault();
				e.stopPropagation();
			}
		}

		window.addEventListener("beforeunload", handleBeforeUnload);
		document.addEventListener("click", handleClick, true);
		document.addEventListener("submit", handleSubmit, true);
		return () =>
		{
			window.removeEventListener("beforeunload", handleBeforeUnload);
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("submit", handleSubmit, true);
		};
	}, [active, router]);
}

export function CreateUserForm()
{
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<CreatableRole | "">("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedUser | null>(null);
	const [copied, setCopied] = useState(false);
	const [justCopied, setJustCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);

	const copyButtonRef = useRef<HTMLButtonElement>(null);

	useLeaveGuard(created !== null && !copied);

	// Design review Decision 25: keyboard/screen-reader users land on the
	// most important element without tabbing from the top of the page.
	useEffect(() =>
	{
		if (created)
		{
			copyButtonRef.current?.focus();
		}
	}, [created]);

	function resetForm()
	{
		// "Agregar otro usuario" discards the password just like leaving the
		// page does — same guard, it's a button so useLeaveGuard can't see it.
		if (created && !copied && !window.confirm(LEAVE_WARNING))
		{
			return;
		}
		setName("");
		setEmail("");
		setRole("");
		setError(null);
		setCreated(null);
		setCopied(false);
		setJustCopied(false);
		setCopyError(false);
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
		// server crash throws — without this the button stays on "Creando..."
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

		const { data, error: actionError } = result;

		if (actionError || !data)
		{
			// Decision 17: values stay — don't force re-typing for an error
			// that likely wasn't the admin's fault (e.g. cross-tenant email
			// collision, hidden behind the generic message).
			setError(actionError ?? "No se pudo crear el usuario. Intenta de nuevo.");
			return;
		}

		setCreated(data);
	}

	async function handleCopy()
	{
		if (!created)
		{
			return;
		}
		try
		{
			await navigator.clipboard.writeText(created.password);
			setCopied(true);
			setCopyError(false);
			setJustCopied(true);
			setTimeout(() => setJustCopied(false), 2000);
		}
		catch
		{
			setCopyError(true);
		}
	}

	if (created)
	{
		return (
			<Card className="max-w-lg">
				<CardContent className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">Usuario creado.</p>

					<div>
						<p className="mb-1 text-xs font-medium text-muted-foreground">{created.email} — {ROLE_LABELS[created.role]}</p>
						<div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
							<span className="flex-1 overflow-x-auto font-mono text-base font-semibold tabular-nums break-all">
								{created.password}
							</span>
							<Button
								ref={copyButtonRef}
								type="button"
								variant={copied ? "secondary" : "default"}
								size="sm"
								onClick={handleCopy}
							>
								{justCopied ? <Check /> : <Copy />}
								{justCopied ? "Copiado" : "Copiar"}
							</Button>
						</div>
						<span className="sr-only" aria-live="polite">{justCopied ? "Contraseña copiada" : ""}</span>
					</div>

					{copyError
						? (
							<Alert variant="destructive">
								<AlertTriangle />
								<AlertDescription>No se pudo copiar automáticamente. Selecciona el texto manualmente.</AlertDescription>
							</Alert>
						)
						: null}

					{!copied
						? (
							<Alert variant="destructive">
								<AlertTriangle />
								<AlertDescription>No copiaste la contraseña. No se puede recuperar — cópiala antes de salir.</AlertDescription>
							</Alert>
						)
						: null}

					<p className="text-xs text-muted-foreground">
						Guarda estas credenciales en otro lugar — todavía no hay una lista de usuarios para consultarlas después.
					</p>

					<Button type="button" variant="outline" onClick={resetForm}>
						Agregar otro usuario
					</Button>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="max-w-lg">
			<CardHeader>
				<CardTitle>Agregar usuario</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="name">Nombre</Label>
						<Input
							id="name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={submitting}
							autoFocus
						/>
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="email">Correo</Label>
						<Input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							disabled={submitting}
						/>
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="role">Rol</Label>
						<Select value={role} onValueChange={(v) => setRole(v as CreatableRole)} disabled={submitting}>
							<SelectTrigger id="role" className="w-full">
								<SelectValue placeholder="Elegir rol" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="operator">Operador</SelectItem>
								<SelectItem value="driver">Driver</SelectItem>
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

					<Button type="submit" disabled={submitting} className="w-full justify-center">
						{submitting ? "Creando..." : "Crear usuario"}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
