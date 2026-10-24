// D9: skeleton while list_tenant_users() runs, so the page doesn't flash
// an empty team before the data arrives.
export default function Loading()
{
	return (
		<div className="flex max-w-[1280px] flex-col gap-4" aria-busy="true" aria-label="Cargando usuarios">
			<div className="h-7 w-32 animate-pulse rounded-md bg-muted" />
			<div className="h-4 w-56 animate-pulse rounded-md bg-muted" />
			<div className="mt-2 flex flex-col gap-3">
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
				))}
			</div>
		</div>
	);
}
