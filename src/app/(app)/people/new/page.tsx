import { getAppContext } from "@/app/(app)/app-session";
import { PersonCreateForm } from "@/components/people/person-create-form";

export default async function NewPersonPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  if (!context.viewer.permissions.includes("person:create")) {
    return (
      <section>
        <h1 className="text-3xl font-semibold">Add person</h1>
        <p className="text-muted-foreground mt-3">
          Your workspace role cannot create person records.
        </p>
      </section>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header>
        <p className="text-primary text-sm font-semibold">People</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Add a person
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          Start a durable research record. Facts and evidence can be added after
          creation.
        </p>
      </header>
      <section className="border-border bg-card rounded-2xl border p-5 shadow-sm sm:p-7">
        <PersonCreateForm />
      </section>
    </div>
  );
}
