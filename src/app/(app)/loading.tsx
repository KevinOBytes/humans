import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <section
      role="status"
      aria-label="Loading research workspace"
      className="mx-auto max-w-5xl space-y-5 px-4 py-10"
    >
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-72 w-full" />
    </section>
  );
}
