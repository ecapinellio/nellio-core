import { redirect } from "next/navigation";

export default function AppHome()
{
	redirect("/orders/capture");
}
