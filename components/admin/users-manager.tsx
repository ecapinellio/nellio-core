"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
	deactivateUser,
	reactivateUser,
	resetUserPassword,
	type ActionResult,
	type Credentials,
} from "@/app/(app)/admin/users/actions";
import type { TenantUser } from "@/lib/users/list-users";
import { roleLabel } from "@/lib/users/role-labels";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { OneTimePasswordDialog } from "@/components/admin/one-time-password-dialog";

type ActionKind = "reset" | "deactivate" | "reactivate";

interface ActionConfig
{
	title: (name: string) => string;
	description: string;
	confirmLabel: string;
	pendingLabel: string;
	destructive: boolean;
	done: (name: string) => string;
	run: (userId: string) => Promise<ActionResult<Credentials | null>>;
}

// Design review D6: say what actually happens, in the owner's terms — and
// for deactivation, that the person's order history is kept.
const ACTIONS: Record<ActionKind, ActionConfig> = {
	reset: {
		title: (name) => `¿Restablecer la contraseña de ${name}?`,
		description: "Su contraseña actual dejará de funcionar y se cerrará su sesión en todos sus dispositivos. Te mostraremos una nueva.",
		confirmLabel: "Restablecer",
		pendingLabel: "Restableciendo…",
		destructive: false,
		done: (name) => `Contraseña de ${name} restablecida`,
		run: resetUserPassword,
	},
	deactivate: {
		title: (name) => `¿Desactivar a ${name}?`,
		description: "No podrá iniciar sesión y se cerrará su sesión en todos sus dispositivos. Sus pedidos se conservan. Puedes reactivarlo después.",
		confirmLabel: "Desactivar",
		pendingLabel: "Desactivando…",
		destructive: true,
		done: (name) => `${name} desactivado`,
		run: deactivateUser,
	},
	reactivate: {
		title: (name) => `¿Reactivar a ${name}?`,
		description: "Podrá volver a iniciar sesión con una contraseña nueva que te mostraremos.",
		confirmLabel: "Reactivar",
		pendingLabel: "Reactivando…",
		destructive: false,
		done: (name) => `${name} reactivado`,
		run: reactivateUser,
	},
};

/** Admins and the caller themself get no actions (eng-review Decision 6). */
function isManageable(user: TenantUser, currentUserId: string): boolean
{
	return user.id !== currentUserId && (user.role === "operator" || user.role === "driver");
}

function UserStatus({ active }: { active: boolean })
{
	return active
		? <StatusBadge label="Activo" color="var(--user-active)" />
		: <StatusBadge label="Desactivado" color="var(--user-inactive)" />;
}

function RowActions({
	user,
	currentUserId,
	onAction,
	className,
	buttonClassName,
}: {
	user: TenantUser;
	currentUserId: string;
	onAction: (kind: ActionKind, user: TenantUser) => void;
	className?: string;
	buttonClassName?: string;
})
{
	if (!isManageable(user, currentUserId))
	{
		return <span className="text-muted-foreground">—</span>;
	}

	return (
		<div className={cn("flex gap-2", className)}>
			{user.active
				? (
					<>
						<Button size="sm" variant="secondary" className={buttonClassName} onClick={() => onAction("reset", user)}>
							Restablecer contraseña
						</Button>
						<Button size="sm" variant="secondary" className={buttonClassName} onClick={() => onAction("deactivate", user)}>
							Desactivar
						</Button>
					</>
				)
				: (
					<Button size="sm" variant="secondary" className={buttonClassName} onClick={() => onAction("reactivate", user)}>
						Reactivar
					</Button>
				)}
		</div>
	);
}

/**
 * /admin/users (RBAC slice 3, design review D1–D12): the list is the page;
 * creating is a dialog; every generated password lands in the single
 * OneTimePasswordDialog, held here at page level so a list refresh
 * (revalidatePath) can't unmount it mid-display.
 */
export function UsersManager({ users, currentUserId }: { users: TenantUser[]; currentUserId: string })
{
	const [confirm, setConfirm] = useState<{ kind: ActionKind; user: TenantUser } | null>(null);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [credentials, setCredentials] = useState<Credentials | null>(null);
	const [announcement, setAnnouncement] = useState("");

	const onlyMe = users.every((u) => u.id === currentUserId);

	function openAction(kind: ActionKind, user: TenantUser)
	{
		setActionError(null);
		setConfirm({ kind, user });
	}

	function closeConfirm()
	{
		if (!pending)
		{
			setConfirm(null);
		}
	}

	async function runConfirmed()
	{
		if (!confirm)
		{
			return;
		}
		const config = ACTIONS[confirm.kind];

		setPending(true);
		setActionError(null);

		let result: ActionResult<Credentials | null>;
		try
		{
			result = await config.run(confirm.user.id);
		}
		catch
		{
			result = { data: null, error: "Algo falló. Intenta de nuevo." };
		}
		finally
		{
			setPending(false);
		}

		// D7: errors stay inside the dialog, which stays open.
		if (result.error)
		{
			setActionError(result.error);
			return;
		}

		setAnnouncement(config.done(confirm.user.name));
		setConfirm(null);
		if (result.data)
		{
			setCredentials(result.data);
		}
	}

	const config = confirm ? ACTIONS[confirm.kind] : null;

	return (
		<div className="flex max-w-[1280px] flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Usuarios</h1>
					<p className="text-sm text-muted-foreground">Administra el acceso de tu equipo.</p>
				</div>
				<CreateUserDialog onCreated={setCredentials} />
			</div>

			{/* Desktop / tablet: table */}
			<div className="hidden sm:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Nombre</TableHead>
							<TableHead>Correo</TableHead>
							<TableHead>Rol</TableHead>
							<TableHead>Estado</TableHead>
							<TableHead>Creado</TableHead>
							<TableHead className="text-right">Acciones</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{users.map((user) => (
							<TableRow key={user.id} className={cn(!user.active && "text-muted-foreground")}>
								<TableCell className="font-medium">
									{user.name}
									{user.id === currentUserId ? <span className="font-normal text-muted-foreground"> (tú)</span> : null}
								</TableCell>
								<TableCell>{user.email}</TableCell>
								<TableCell>{roleLabel(user.role)}</TableCell>
								<TableCell><UserStatus active={user.active} /></TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{formatDate(user.createdAt)}</TableCell>
								<TableCell className="text-right">
									<RowActions user={user} currentUserId={currentUserId} onAction={openAction} className="justify-end" />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>

			{/* Phone (D10): stacked blocks, full-width 44px buttons */}
			<ul className="flex flex-col divide-y divide-border rounded-lg border border-border sm:hidden">
				{users.map((user) => (
					<li key={user.id} className={cn("flex flex-col gap-1.5 p-4", !user.active && "text-muted-foreground")}>
						<p className="font-semibold">
							{user.name}
							{user.id === currentUserId ? <span className="font-normal text-muted-foreground"> (tú)</span> : null}
						</p>
						<p className="break-all text-sm">{user.email}</p>
						<div className="flex items-center gap-3 text-sm">
							<span>{roleLabel(user.role)}</span>
							<UserStatus active={user.active} />
						</div>
						{isManageable(user, currentUserId)
							? (
								<RowActions
									user={user}
									currentUserId={currentUserId}
									onAction={openAction}
									className="mt-2 flex-col"
									buttonClassName="h-11 w-full"
								/>
							)
							: null}
					</li>
				))}
			</ul>

			{/* D8: the admin alone is the real empty state */}
			{onlyMe
				? (
					<div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
						Todavía no agregaste a nadie de tu equipo.
						<CreateUserDialog onCreated={setCredentials} />
					</div>
				)
				: null}

			<span className="sr-only" aria-live="polite">{announcement}</span>

			<Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) closeConfirm(); }}>
				<DialogContent showCloseButton={false} className="sm:max-w-md">
					{confirm && config
						? (
							<>
								<DialogHeader>
									<DialogTitle>{config.title(confirm.user.name)}</DialogTitle>
									<DialogDescription>{config.description}</DialogDescription>
								</DialogHeader>
								{actionError
									? (
										<Alert variant="destructive">
											<AlertTriangle />
											<AlertDescription>{actionError}</AlertDescription>
										</Alert>
									)
									: null}
								<DialogFooter>
									<Button variant="secondary" onClick={closeConfirm} disabled={pending}>Cancelar</Button>
									<Button
										variant={config.destructive ? "destructive" : "default"}
										onClick={runConfirmed}
										disabled={pending}
									>
										{pending ? <Loader2 className="animate-spin" /> : null}
										{pending ? config.pendingLabel : config.confirmLabel}
									</Button>
								</DialogFooter>
							</>
						)
						: null}
				</DialogContent>
			</Dialog>

			<OneTimePasswordDialog credentials={credentials} onClose={() => setCredentials(null)} />
		</div>
	);
}
