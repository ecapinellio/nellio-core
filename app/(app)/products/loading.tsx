// Skeleton while the catalog loads, so it doesn't flash the empty-catalog guide.
export default function Loading()
{
	return (
		<div className="flex max-w-[1280px] flex-col gap-4" aria-busy="true" aria-label="Cargando productos">
			<div className="h-7 w-32 animate-pulse rounded-md bg-muted" />
			<div className="h-4 w-56 animate-pulse rounded-md bg-muted" />
			<div className="h-9 w-72 animate-pulse rounded-md bg-muted" />
			<div className="mt-2 flex flex-col gap-2">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
				))}
			</div>
		</div>
	);
}
