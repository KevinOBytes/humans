import { getAppContext } from "@/app/(app)/app-session";
import { ResearchAssignmentQueue } from "@/components/cases/research-assignment-queue";

export default async function AssignmentsPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;

  return (
    <div className="space-y-5" aria-labelledby="workspace-assignments-heading">
      <header>
        <h1
          id="workspace-assignments-heading"
          className="text-3xl font-semibold"
        >
          Workspace assignments
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          Review workspace-level work items and case assignments visible to your
          current membership. Case membership is rechecked by the API; this
          queue never grants access to a case or its resources.
        </p>
      </header>
      <ResearchAssignmentQueue
        canManageWorkspace={context.viewer.permissions.includes(
          "workspace:update",
        )}
      />
    </div>
  );
}
