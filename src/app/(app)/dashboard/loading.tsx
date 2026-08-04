import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <section
      role="status"
      aria-label="Loading research dashboard"
      className="space-y-8"
    >
      <span className="sr-only">Loading research dashboard</span>
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-72" />
        ))}
      </div>
      <Skeleton className="h-56" />
    </section>
  );
}
