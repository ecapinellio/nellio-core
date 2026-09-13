import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Driver has no route to land on yet — the delivery/assignment data model
// is still pending discovery (CLAUDE.md §4). This placeholder is what
// Decision 8/9 of the T8 plan calls for: driver logs in successfully but
// sees nothing until that model exists, instead of the capture screen.
export default async function AppHome()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	if (user?.app_metadata.role === "driver")
	{
		return (
			<div className="flex h-full flex-col items-center justify-center text-center">
				<p className="text-sm text-muted-foreground">Aún no tienes entregas asignadas.</p>
			</div>
		);
	}

	redirect("/orders/capture");
}
