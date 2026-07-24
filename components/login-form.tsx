"use client";

import { useActionState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { login, type LoginState } from "@/lib/auth/actions";

const initialState: LoginState = { error: null };

export function LoginForm({ next }: { next: string })
{
	const [state, formAction, pending] = useActionState(login, initialState);

	return (
		<form action={formAction} className="flex flex-col gap-4">
			<input type="hidden" name="next" value={next} />

			{state.error
				? (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertDescription>{state.error}</AlertDescription>
					</Alert>
				)
				: null}

			<div className="flex flex-col gap-2">
				<Label htmlFor="email">Correo</Label>
				<Input
					id="email"
					name="email"
					type="email"
					autoComplete="email"
					placeholder="alejandra@ectec.com"
					required
				/>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor="password">Contraseña</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="current-password"
					placeholder="••••••••••"
					required
				/>
			</div>

			<Button type="submit" disabled={pending} className="mt-2 w-full justify-center">
				{pending ? "Entrando..." : "Entrar"}
			</Button>

			<p className="text-center text-xs text-muted-foreground">
				¿Problemas para entrar? Contacta a tu administrador.
			</p>
		</form>
	);
}
