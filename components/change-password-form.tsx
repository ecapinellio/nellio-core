"use client";

import { useActionState, useState } from "react";
import { AlertCircle, Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { changePassword, type ChangePasswordState } from "@/lib/auth/actions";
import { PASSWORD_RULES } from "@/lib/auth/password";
import { cn } from "@/lib/utils";

const initialState: ChangePasswordState = { error: null };

export function ChangePasswordForm({ forced }: { forced: boolean })
{
	const [state, formAction, pending] = useActionState(changePassword, initialState);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const allMet = PASSWORD_RULES.every((rule) => rule.test(password));
	const mismatch = confirm !== "" && confirm !== password;

	return (
		<form action={formAction} className="flex flex-col gap-4">
			{state.error
				? (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertDescription>{state.error}</AlertDescription>
					</Alert>
				)
				: null}

			{!forced
				? (
					<div className="flex flex-col gap-2">
						<Label htmlFor="current">Contraseña actual</Label>
						<Input
							id="current"
							name="current"
							type="password"
							autoComplete="current-password"
							required
							className="h-11 md:h-9"
						/>
					</div>
				)
				: null}

			<div className="flex flex-col gap-2">
				<Label htmlFor="password">Contraseña nueva</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					aria-describedby="password-rules"
					required
					className="h-11 md:h-9"
				/>
				{/* Live checklist: the same rules the server and Supabase Auth enforce. */}
				<ul id="password-rules" aria-label="Requisitos de la contraseña" className="flex flex-col gap-1 text-xs">
					{PASSWORD_RULES.map((rule) =>
					{
						const met = rule.test(password);
						return (
							<li key={rule.id} className={cn("flex items-center gap-1.5", met ? "text-status-delivered" : "text-muted-foreground")}>
								{met ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
								{rule.label}
								<span className="sr-only">{met ? "(cumplido)" : "(pendiente)"}</span>
							</li>
						);
					})}
				</ul>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor="confirm">Repite la contraseña</Label>
				<Input
					id="confirm"
					name="confirm"
					type="password"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					aria-invalid={mismatch || undefined}
					aria-describedby={mismatch ? "confirm-msg" : undefined}
					required
					className="h-11 md:h-9"
				/>
				{mismatch ? <p id="confirm-msg" className="text-xs font-medium text-destructive">No coincide con la contraseña nueva.</p> : null}
			</div>

			<Button type="submit" disabled={pending || !allMet || confirm !== password} className="mt-2 h-11 w-full justify-center md:h-9">
				{pending ? "Guardando…" : forced ? "Guardar y entrar" : "Cambiar contraseña"}
			</Button>
		</form>
	);
}
