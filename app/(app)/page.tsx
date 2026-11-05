import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AppHome()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	redirect(user?.app_metadata.role === "driver" ? "/deliveries" : "/orders/capture");
}
