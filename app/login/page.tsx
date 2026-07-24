import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
	title: "Iniciar sesión — Nellio Core",
};

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>;
})
{
	const { next } = await searchParams;

	return (
		<div className="flex min-h-screen">
			<div className="hidden w-[42%] flex-col justify-between bg-zinc-900 p-12 text-zinc-50 lg:flex">
				<div className="flex items-center text-sm font-bold tracking-tight">
					<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
					Nellio Core
				</div>
				<div className="max-w-sm">
					<p className="text-xl font-medium leading-snug tracking-tight text-zinc-100">
						&ldquo;Antes vivíamos en cinco hojas de cálculo distintas. Ahora todo pedido pasa por un solo lugar.&rdquo;
					</p>
					<p className="mt-3 text-sm text-zinc-500">— Alejandra, Operaciones</p>
				</div>
				<p className="text-xs text-zinc-600">© {new Date().getFullYear()} Nellio Core</p>
			</div>

			<div className="flex flex-1 items-center justify-center bg-background p-8">
				<div className="w-full max-w-sm">
					<h1 className="text-xl font-semibold tracking-tight">Iniciar sesión</h1>
					<p className="mb-8 mt-1 text-sm text-muted-foreground">Ingresa con tu cuenta del equipo.</p>
					<LoginForm next={next ?? "/"} />
				</div>
			</div>
		</div>
	);
}
