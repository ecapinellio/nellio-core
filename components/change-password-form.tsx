"use client";

import { useActionState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { changePassword, type ChangePasswordState } from "@/lib/auth/actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const initialState: ChangePasswordState = { error: null };

export function ChangePasswordForm({ forced }: { forced: boolean })
{
	const [state, formAction, pending] = useActionState(changePassword, initialState);

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
					minLength={MIN_PASSWORD_LENGTH}
					aria-describedby="password-hint"
					required
					className="h-11 md:h-9"
				/>
				<p id="password-hint" className="text-xs text-muted-foreground">
					Al menos {MIN_PASSWORD_LENGTH} caracteres. Una frase corta es fácil de recordar y difícil de adivinar.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor="confirm">Repite la contraseña</Label>
				<Input
					id="confirm"
					name="confirm"
					type="password"
					autoComplete="new-password"
					required
					className="h-11 md:h-9"
				/>
			</div>

			<Button type="submit" disabled={pending} className="mt-2 h-11 w-full justify-center md:h-9">
				{pending ? "Guardando…" : forced ? "Guardar y entrar" : "Cambiar contraseña"}
			</Button>
		</form>
	);
}
