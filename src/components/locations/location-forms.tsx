"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ArchivePersonAddressDocument,
  ArchivePersonContactDocument,
  ArchivePlaceDocument,
  AddressEditProjectionDocument,
  type AddressEditProjectionQuery,
  AddressDisplayProjectionDocument,
  type AddressDisplayProjectionQuery,
  ContactEditProjectionDocument,
  type ContactEditProjectionQuery,
  ContactDisplayProjectionDocument,
  type ContactDisplayProjectionQuery,
  CreatePersonAddressDocument,
  CreatePersonContactDocument,
  CreatePlaceDocument,
  UpdatePersonAddressDocument,
  UpdatePersonContactDocument,
  UpdatePlaceDocument,
} from "@/graphql/generated/graphql";

type PlaceOption = { id: string; name: string };

export function ProtectedContactPresentation(props: {
  associationId: string;
  version: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${props.associationId}:${props.version}:${attempt}`;
  const [resolution, setResolution] = useState<{
    failed: boolean;
    key: string;
    projection:
      ContactDisplayProjectionQuery["contactDisplayProjection"] | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void executeBrowserGraphQL(
      ContactDisplayProjectionDocument,
      { associationId: props.associationId },
      { signal: controller.signal },
    ).then((result) => {
      if (!active || controller.signal.aborted) return;
      if (
        !result.ok ||
        result.data.contactDisplayProjection.associationId !==
          props.associationId
      ) {
        setResolution({ failed: true, key: requestKey, projection: null });
        return;
      }
      setResolution({
        failed: false,
        key: requestKey,
        projection: result.data.contactDisplayProjection,
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [props.associationId, requestKey]);

  const current = resolution?.key === requestKey ? resolution : null;
  const projection = current?.projection ?? null;

  if (!current)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading protected contact…
      </p>
    );
  if (current.failed || !projection)
    return (
      <div role="alert" className="space-y-2">
        <p className="text-destructive text-sm">
          The protected contact could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry protected contact
        </Button>
      </div>
    );
  return (
    <div>
      <p className="font-mono text-base break-all">{projection.displayValue}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {projection.label ?? projection.usageKind}
      </p>
    </div>
  );
}

export function ProtectedAddressPresentation(props: {
  associationId: string;
  version: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${props.associationId}:${props.version}:${attempt}`;
  const [resolution, setResolution] = useState<{
    failed: boolean;
    key: string;
    projection:
      AddressDisplayProjectionQuery["addressDisplayProjection"] | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void executeBrowserGraphQL(
      AddressDisplayProjectionDocument,
      { associationId: props.associationId },
      { signal: controller.signal },
    ).then((result) => {
      if (!active || controller.signal.aborted) return;
      if (
        !result.ok ||
        result.data.addressDisplayProjection.associationId !==
          props.associationId
      ) {
        setResolution({ failed: true, key: requestKey, projection: null });
        return;
      }
      setResolution({
        failed: false,
        key: requestKey,
        projection: result.data.addressDisplayProjection,
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [props.associationId, requestKey]);

  const current = resolution?.key === requestKey ? resolution : null;
  const projection = current?.projection ?? null;

  if (!current)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading protected address…
      </p>
    );
  if (current.failed || !projection)
    return (
      <div role="alert" className="space-y-2">
        <p className="text-destructive text-sm">
          The protected address could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry protected address
        </Button>
      </div>
    );
  return (
    <address className="not-italic">
      <p className="font-semibold">
        {projection.line1 ?? projection.unstructuredText}
      </p>
      {projection.line2 ? <p>{projection.line2}</p> : null}
      <p className="text-muted-foreground">
        {[
          projection.locality,
          projection.region,
          projection.postalCode,
          projection.countryCode,
        ]
          .filter(Boolean)
          .join(", ")}
      </p>
      {projection.place ? (
        <p className="text-muted-foreground mt-2 text-sm">
          Place: {projection.place.name}
        </p>
      ) : null}
    </address>
  );
}

function messageFor(result: unknown, fallback: string): string {
  if (!result || typeof result !== "object") return fallback;
  const value = result as {
    code?: string | null;
    issues?: readonly { message?: string | null }[] | null;
  };
  return (
    value.issues?.find((item) => item.message)?.message ??
    (value.code === "CONFLICT"
      ? "This record changed in another request. Reload and try again."
      : fallback)
  );
}

export function PhoneContactForm({ personId }: { personId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"PHONE" | "EMAIL" | "OTHER">("PHONE");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(CreatePersonContactDocument, {
      input: {
        personId,
        kind,
        value: String(data.get("value") ?? ""),
        label: String(data.get("label") ?? "") || undefined,
        usageKind: String(data.get("usageKind") ?? "personal"),
        sensitivity: String(data.get("sensitivity") ?? "INTERNAL") as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
        isPrimary: data.get("isPrimary") === "on",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.errors[0]?.message ?? "The phone could not be saved.");
      return;
    }
    const payload = result.data.createPersonContact;
    if (!payload?.contact) {
      setError(messageFor(payload, "The phone could not be saved."));
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form
      aria-label="Add protected contact"
      onSubmit={submit}
      className="border-border bg-card grid gap-4 rounded-2xl border p-5"
    >
      <h3 className="font-semibold">Add protected contact</h3>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="phone-kind">Contact kind</Label>
          <select
            id="phone-kind"
            name="kind"
            value={kind}
            onChange={(event) =>
              setKind(event.currentTarget.value as "PHONE" | "EMAIL" | "OTHER")
            }
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="PHONE">Phone</option>
            <option value="EMAIL">Email</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone-value">
            {kind === "PHONE"
              ? "Phone number"
              : kind === "EMAIL"
                ? "Email address"
                : "Contact value"}
          </Label>
          <Input
            id="phone-value"
            name="value"
            type={
              kind === "PHONE" ? "tel" : kind === "EMAIL" ? "email" : "text"
            }
            autoComplete="off"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone-label">Label</Label>
          <Input id="phone-label" name="label" placeholder="Mobile" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone-usage">Usage</Label>
          <Input
            id="phone-usage"
            name="usageKind"
            defaultValue="personal"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone-sensitivity">Sensitivity</Label>
          <select
            id="phone-sensitivity"
            name="sensitivity"
            defaultValue="INTERNAL"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option>PUBLIC</option>
            <option>INTERNAL</option>
            <option>CONFIDENTIAL</option>
            <option>RESTRICTED</option>
          </select>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input name="isPrimary" type="checkbox" /> Current primary contact
      </label>
      <div>
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add contact"}
        </Button>
      </div>
    </form>
  );
}

export function AddressForm({
  personId,
  places,
}: {
  personId: string;
  places: readonly PlaceOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const placeId = String(data.get("placeId") ?? "");
    const result = await executeBrowserGraphQL(CreatePersonAddressDocument, {
      input: {
        personId,
        addressKind: String(data.get("addressKind") ?? "residence"),
        line1: String(data.get("line1") ?? "") || undefined,
        line2: String(data.get("line2") ?? "") || undefined,
        locality: String(data.get("locality") ?? "") || undefined,
        region: String(data.get("region") ?? "") || undefined,
        postalCode: String(data.get("postalCode") ?? "") || undefined,
        countryCode: String(data.get("countryCode") ?? "") || undefined,
        placeId: placeId || undefined,
        sensitivity: String(data.get("sensitivity") ?? "INTERNAL") as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
        isPrimary: data.get("isPrimary") === "on",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.errors[0]?.message ?? "The address could not be saved.");
      return;
    }
    const payload = result.data.createPersonAddress;
    if (!payload?.address) {
      setError(messageFor(payload, "The address could not be saved."));
      return;
    }
    form.reset();
    router.refresh();
  }
  return (
    <form
      aria-label="Add address"
      onSubmit={submit}
      className="border-border bg-card grid gap-4 rounded-2xl border p-5"
    >
      <h3 className="font-semibold">Add address</h3>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="address-line1"
          label="Address line 1"
          name="line1"
          required
        />
        <Field id="address-line2" label="Address line 2" name="line2" />
        <Field id="address-locality" label="Locality" name="locality" />
        <Field id="address-region" label="Region" name="region" />
        <Field id="address-postal" label="Postal code" name="postalCode" />
        <Field
          id="address-country"
          label="Country code"
          name="countryCode"
          maxLength={2}
        />
        <Field
          id="address-kind"
          label="Address kind"
          name="addressKind"
          defaultValue="residence"
          required
        />
        <div className="space-y-2">
          <Label htmlFor="address-place">Reusable place</Label>
          <select
            id="address-place"
            name="placeId"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="">No linked place</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="address-sensitivity">Sensitivity</Label>
          <select
            id="address-sensitivity"
            name="sensitivity"
            defaultValue="INTERNAL"
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option>PUBLIC</option>
            <option>INTERNAL</option>
            <option>CONFIDENTIAL</option>
            <option>RESTRICTED</option>
          </select>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input name="isPrimary" type="checkbox" /> Current primary address
      </label>
      <div>
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add address"}
        </Button>
      </div>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  name: string;
  required?: boolean;
  maxLength?: number;
  defaultValue?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input {...props} />
    </div>
  );
}

type SensitivityInput = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export function ContactEditForm(props: { associationId: string }) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projection, setProjection] = useState<
    ContactEditProjectionQuery["contactEditProjection"] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function discardProjection() {
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setProjection(null);
    setLoading(false);
    setLoadError(null);
    setError(null);
  }

  function closeDisclosure() {
    discardProjection();
    setExpanded(false);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  async function loadProjection() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setProjection(null);
    setLoading(true);
    setLoadError(null);
    setError(null);
    const result = await executeBrowserGraphQL(
      ContactEditProjectionDocument,
      { associationId: props.associationId },
      { signal: controller.signal },
    );
    if (requestRef.current !== request || controller.signal.aborted) return;
    controllerRef.current = null;
    setLoading(false);
    if (
      !result.ok ||
      result.data.contactEditProjection.associationId !== props.associationId
    ) {
      setLoadError("The protected contact editor could not be loaded.");
      return;
    }
    setProjection(result.data.contactEditProjection);
  }

  useEffect(() => {
    const request = requestRef;
    const controller = controllerRef;
    return () => {
      request.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [props.associationId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !projection) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(UpdatePersonContactDocument, {
      input: {
        associationId: props.associationId,
        expectedVersion: projection.version,
        expectedContactVersion: projection.contactVersion,
        value: String(data.get("value") ?? ""),
        label: String(data.get("label") ?? "") || null,
        usageKind: String(data.get("usageKind") ?? "personal"),
        sensitivity: String(
          data.get("sensitivity") ?? "INTERNAL",
        ) as SensitivityInput,
        isPrimary: data.get("isPrimary") === "on",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(
        result.errors[0]?.message ?? "The contact could not be updated.",
      );
      return;
    }
    const payload = result.data.updatePersonContact;
    if (!payload?.contact) {
      setError(messageFor(payload, "The contact could not be updated."));
      return;
    }
    closeDisclosure();
    router.refresh();
  }
  return (
    <details ref={detailsRef} className="mt-4">
      <summary
        className="cursor-pointer text-sm font-semibold"
        onClick={(event) => {
          const opening = event.currentTarget.closest("details")?.open !== true;
          if (opening) {
            setExpanded(true);
            void loadProjection();
          } else {
            discardProjection();
            setExpanded(false);
          }
        }}
      >
        Edit contact
      </summary>
      {expanded && loading ? (
        <p role="status" className="text-muted-foreground mt-3 text-sm">
          Loading protected contact editor…
        </p>
      ) : null}
      {expanded && loadError ? (
        <div role="alert" className="mt-3 space-y-3">
          <p className="text-destructive text-sm">{loadError}</p>
          <Button type="button" variant="outline" onClick={loadProjection}>
            Retry contact editor
          </Button>
        </div>
      ) : null}
      {expanded && projection ? (
        <form
          aria-label="Edit protected contact"
          className="mt-3 grid gap-3"
          onSubmit={submit}
        >
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <Field
            id={`contact-value-${props.associationId}`}
            label="Contact value"
            name="value"
            defaultValue={projection.displayValue}
            required
          />
          <Field
            id={`contact-label-${props.associationId}`}
            label="Label"
            name="label"
            defaultValue={projection.label ?? ""}
          />
          <Field
            id={`contact-usage-${props.associationId}`}
            label="Usage"
            name="usageKind"
            defaultValue={projection.usageKind}
            required
          />
          <label className="space-y-2 text-sm">
            <span className="block font-medium">Sensitivity</span>
            <select
              name="sensitivity"
              defaultValue={projection.sensitivity}
              className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
            >
              <option>PUBLIC</option>
              <option>INTERNAL</option>
              <option>CONFIDENTIAL</option>
              <option>RESTRICTED</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              name="isPrimary"
              type="checkbox"
              defaultChecked={projection.isPrimary}
            />{" "}
            Current primary contact
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save contact"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={closeDisclosure}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </details>
  );
}

export function AddressEditForm(props: {
  associationId: string;
  places: readonly PlaceOption[];
}) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projection, setProjection] = useState<
    AddressEditProjectionQuery["addressEditProjection"] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function discardProjection() {
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setProjection(null);
    setLoading(false);
    setLoadError(null);
    setError(null);
  }

  function closeDisclosure() {
    discardProjection();
    setExpanded(false);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  async function loadProjection() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setProjection(null);
    setLoading(true);
    setLoadError(null);
    setError(null);
    const result = await executeBrowserGraphQL(
      AddressEditProjectionDocument,
      { associationId: props.associationId },
      { signal: controller.signal },
    );
    if (requestRef.current !== request || controller.signal.aborted) return;
    controllerRef.current = null;
    setLoading(false);
    if (
      !result.ok ||
      result.data.addressEditProjection.associationId !== props.associationId
    ) {
      setLoadError("The address editor could not be loaded.");
      return;
    }
    setProjection(result.data.addressEditProjection);
  }

  useEffect(() => {
    const request = requestRef;
    const controller = controllerRef;
    return () => {
      request.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [props.associationId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !projection) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const placeId = String(data.get("placeId") ?? "");
    const result = await executeBrowserGraphQL(UpdatePersonAddressDocument, {
      input: {
        associationId: props.associationId,
        expectedVersion: projection.version,
        expectedAddressVersion: projection.addressVersion,
        addressKind: String(data.get("addressKind") ?? "residence"),
        line1: String(data.get("line1") ?? "") || null,
        locality: String(data.get("locality") ?? "") || null,
        region: String(data.get("region") ?? "") || null,
        postalCode: String(data.get("postalCode") ?? "") || null,
        countryCode: String(data.get("countryCode") ?? "") || null,
        placeId: placeId || null,
        sensitivity: String(
          data.get("sensitivity") ?? "INTERNAL",
        ) as SensitivityInput,
        isPrimary: data.get("isPrimary") === "on",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(
        result.errors[0]?.message ?? "The address could not be updated.",
      );
      return;
    }
    const payload = result.data.updatePersonAddress;
    if (!payload?.address) {
      setError(messageFor(payload, "The address could not be updated."));
      return;
    }
    closeDisclosure();
    router.refresh();
  }
  return (
    <details ref={detailsRef} className="mt-4">
      <summary
        className="cursor-pointer text-sm font-semibold"
        onClick={(event) => {
          const opening = event.currentTarget.closest("details")?.open !== true;
          if (opening) {
            setExpanded(true);
            void loadProjection();
          } else {
            discardProjection();
            setExpanded(false);
          }
        }}
      >
        Edit address
      </summary>
      {expanded && loading ? (
        <p role="status" className="text-muted-foreground mt-3 text-sm">
          Loading address editor…
        </p>
      ) : null}
      {expanded && loadError ? (
        <div role="alert" className="mt-3 space-y-3">
          <p className="text-destructive text-sm">{loadError}</p>
          <Button type="button" variant="outline" onClick={loadProjection}>
            Retry address editor
          </Button>
        </div>
      ) : null}
      {expanded && projection ? (
        <form
          aria-label="Edit address"
          className="mt-3 grid gap-3"
          onSubmit={submit}
        >
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <Field
            id={`address-edit-line1-${props.associationId}`}
            label="Address line 1"
            name="line1"
            defaultValue={projection.line1 ?? ""}
            required
          />
          <Field
            id={`address-edit-locality-${props.associationId}`}
            label="Locality"
            name="locality"
            defaultValue={projection.locality ?? ""}
          />
          <Field
            id={`address-edit-region-${props.associationId}`}
            label="Region"
            name="region"
            defaultValue={projection.region ?? ""}
          />
          <Field
            id={`address-edit-postal-${props.associationId}`}
            label="Postal code"
            name="postalCode"
            defaultValue={projection.postalCode ?? ""}
          />
          <Field
            id={`address-edit-country-${props.associationId}`}
            label="Country code"
            name="countryCode"
            defaultValue={projection.countryCode ?? ""}
            maxLength={2}
          />
          <Field
            id={`address-edit-kind-${props.associationId}`}
            label="Address kind"
            name="addressKind"
            defaultValue={projection.addressKind}
            required
          />
          <label className="space-y-2 text-sm">
            <span className="block font-medium">Reusable place</span>
            <select
              name="placeId"
              defaultValue={projection.place?.id ?? ""}
              className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
            >
              <option value="">No linked place</option>
              {props.places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="block font-medium">Sensitivity</span>
            <select
              name="sensitivity"
              defaultValue={projection.sensitivity}
              className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
            >
              <option>PUBLIC</option>
              <option>INTERNAL</option>
              <option>CONFIDENTIAL</option>
              <option>RESTRICTED</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              name="isPrimary"
              type="checkbox"
              defaultChecked={projection.isPrimary}
            />{" "}
            Current primary address
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save address"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={closeDisclosure}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </details>
  );
}

export function PlaceForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(CreatePlaceDocument, {
      input: {
        name: String(data.get("name") ?? ""),
        kind: String(data.get("kind") ?? "locality"),
        locality: String(data.get("locality") ?? "") || undefined,
        region: String(data.get("region") ?? "") || undefined,
        countryCode: String(data.get("countryCode") ?? "") || undefined,
        sensitivity: "INTERNAL",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok || !result.data.createPlace?.place) {
      setError(
        result.ok
          ? messageFor(result.data.createPlace, "The place could not be saved.")
          : (result.errors[0]?.message ?? "The place could not be saved."),
      );
      return;
    }
    form.reset();
    router.refresh();
  }
  return (
    <form
      aria-label="Add reusable place"
      onSubmit={submit}
      className="border-border bg-card grid gap-4 rounded-2xl border p-5"
    >
      <h3 className="font-semibold">Add reusable place</h3>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="place-name" label="Place name" name="name" required />
        <Field
          id="place-kind"
          label="Place kind"
          name="kind"
          defaultValue="locality"
          required
        />
        <Field id="place-locality" label="Locality" name="locality" />
        <Field id="place-region" label="Region" name="region" />
        <Field
          id="place-country"
          label="Country code"
          name="countryCode"
          maxLength={2}
        />
      </div>
      <div>
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add place"}
        </Button>
      </div>
    </form>
  );
}

export function PlaceEditForm(props: {
  id: string;
  expectedVersion: number;
  name: string;
  kind: string;
  locality?: string | null;
  region?: string | null;
  countryCode?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(UpdatePlaceDocument, {
      input: {
        id: props.id,
        expectedVersion: props.expectedVersion,
        name: String(data.get("name") ?? ""),
        kind: String(data.get("kind") ?? "locality"),
        locality: String(data.get("locality") ?? "") || null,
        region: String(data.get("region") ?? "") || null,
        countryCode: String(data.get("countryCode") ?? "") || null,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.errors[0]?.message ?? "The place could not be updated.");
      return;
    }
    const payload = result.data.updatePlace;
    if (!payload?.place) {
      setError(messageFor(payload, "The place could not be updated."));
      return;
    }
    router.refresh();
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm font-semibold">
        Edit place
      </summary>
      <form
        aria-label={`Edit ${props.name}`}
        className="mt-3 grid gap-3"
        onSubmit={submit}
      >
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Field
          id={`place-edit-name-${props.id}`}
          label="Place name"
          name="name"
          defaultValue={props.name}
          required
        />
        <Field
          id={`place-edit-kind-${props.id}`}
          label="Place kind"
          name="kind"
          defaultValue={props.kind}
          required
        />
        <Field
          id={`place-edit-locality-${props.id}`}
          label="Locality"
          name="locality"
          defaultValue={props.locality ?? ""}
        />
        <Field
          id={`place-edit-region-${props.id}`}
          label="Region"
          name="region"
          defaultValue={props.region ?? ""}
        />
        <Field
          id={`place-edit-country-${props.id}`}
          label="Country code"
          name="countryCode"
          defaultValue={props.countryCode ?? ""}
          maxLength={2}
        />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save place"}
          </Button>
        </div>
      </form>
    </details>
  );
}

export function ArchivePlaceButton(props: {
  id: string;
  expectedVersion: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function archive() {
    if (pending || !confirm("Archive this reusable place?")) return;
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(ArchivePlaceDocument, {
      input: { ...props, idempotencyKey: crypto.randomUUID() },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.errors[0]?.message ?? "The place could not be archived.");
      return;
    }
    const payload = result.data.archivePlace;
    if (payload?.code !== "ARCHIVED") {
      setError(messageFor(payload, "The place could not be archived."));
      return;
    }
    router.refresh();
  }
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={archive}
      >
        {pending ? "Archiving…" : "Archive place"}
      </Button>
    </div>
  );
}

export function ArchiveContactButton(props: {
  associationId: string;
  expectedVersion: number;
  expectedContactVersion: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function archive() {
    if (pending || !confirm("Archive this contact association?")) return;
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(ArchivePersonContactDocument, {
      input: { ...props, idempotencyKey: crypto.randomUUID() },
    });
    setPending(false);
    if (!result.ok) {
      setError(
        result.errors[0]?.message ?? "The contact could not be archived.",
      );
      return;
    }
    const payload = result.data.archivePersonContact;
    if (payload?.code !== "ARCHIVED") {
      setError(messageFor(payload, "The contact could not be archived."));
      return;
    }
    router.refresh();
  }
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={archive}
      >
        {pending ? "Archiving…" : "Archive contact"}
      </Button>
    </div>
  );
}

export function ArchiveAddressButton(props: {
  associationId: string;
  expectedVersion: number;
  expectedAddressVersion: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function archive() {
    if (pending || !confirm("Archive this address association?")) return;
    setPending(true);
    setError(null);
    const result = await executeBrowserGraphQL(ArchivePersonAddressDocument, {
      input: { ...props, idempotencyKey: crypto.randomUUID() },
    });
    setPending(false);
    if (!result.ok) {
      setError(
        result.errors[0]?.message ?? "The address could not be archived.",
      );
      return;
    }
    const payload = result.data.archivePersonAddress;
    if (payload?.code !== "ARCHIVED") {
      setError(messageFor(payload, "The address could not be archived."));
      return;
    }
    router.refresh();
  }
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={archive}
      >
        {pending ? "Archiving…" : "Archive address"}
      </Button>
    </div>
  );
}
