import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Service, Mutate } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { SettingsSelect } from "./settings-select";
import { Separator } from "./components/ui/separator";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemActions,
} from "./components/ui/item";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./components/ui/alert-dialog";
import { Switch } from "./components/ui/switch";
import { MoreHorizontal, KeyRound, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "./components/ui/dropdown-menu";
import { serviceLabel } from "./service-layout";
import { serviceRuntime } from "./service-runtime";
import { PriorityGroupBadge } from "./priority-group-badge";
import { time, type Snapshot } from "./api";
import { Badge } from "./components/ui/badge";
import { SettingNumber } from "./setting-number";
import { PolicyField } from "./policy-field";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "./components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { Alert, AlertDescription } from "./components/ui/alert";
import { MotionReveal, useSemanticMotion } from "./motion";
export function ServiceEditor({
  service,
  configRevision,
  mutate,
  pending,
  onCredential,
  mode = "policy",
  readOnly = false,
  snapshot,
}: {
  service: Service;
  mode?: "policy" | "access";
  readOnly?: boolean;
  snapshot?: Snapshot;
  configRevision: number;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  }) => void;
}) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [config, setConfig] = useState(service.config);
  const [dirty, setDirty] = useState(false);
  const edits = useRef(0);
  const [resetVersion, setResetVersion] = useState(0);
  const remotePolicy = [
    service.config.visibleMs,
    service.config.snoozeMs,
    service.config.heartbeatMs,
    service.config.exit,
  ].join(":");
  const lastPolicy = useRef(remotePolicy);
  const [baseRevision, setBaseRevision] = useState(configRevision);
  const [saved, setSaved] = useState(0);
  useSemanticMotion(formRef, saved);
  useEffect(() => {
    if (!dirty) {
      if (lastPolicy.current !== remotePolicy) setResetVersion((v) => v + 1);
      lastPolicy.current = remotePolicy;
      setConfig(service.config);
      setBaseRevision(configRevision);
    }
  }, [service.config, configRevision, dirty, remotePolicy]);
  const edit = (key: string, value: unknown) => {
    edits.current++;
    setConfig((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || pending) return;
    const submittedEdit = edits.current;
    const policy = {
      visibleMs: config.visibleMs,
      heartbeatMs: config.heartbeatMs,
    };
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}`,
      { expectedRevision: baseRevision, config: policy },
      "PATCH",
    );
    if (result) {
      setSaved((value) => value + 1);
      if (edits.current === submittedEdit) {
        const form = formRef.current;
        if (
          form?.getClientRects().length &&
          (document.activeElement === document.body ||
            form
              .querySelector(".policy-actions")
              ?.contains(document.activeElement))
        )
          form.focus({ preventScroll: true });
        setDirty(false);
      } else {
        const state = result.snapshot as
          { configRevision?: number } | undefined;
        if (typeof state?.configRevision === "number")
          setBaseRevision(state.configRevision);
      }
    }
  };
  if (mode === "access")
    return (
      <ServiceAccess
        service={service}
        snapshot={snapshot}
        configRevision={configRevision}
        mutate={mutate}
        pending={pending || readOnly}
        onCredential={onCredential}
      />
    );
  return (
    <form
      ref={formRef}
      tabIndex={-1}
      aria-label={`${serviceLabel(service)} settings`}
      className="policy-card motion-surface @container/policy outline-none"
      id={formId}
      onSubmit={(event) => void save(event)}
    >
      <FieldGroup className="grid grid-cols-1 gap-x-4 gap-y-5 @xl/policy:grid-cols-2">
        <PolicyField
          key={`visibleMs-${resetVersion}`}
          disabled={pending || readOnly}
          field="visibleMs"
          value={config.visibleMs}
          onChange={(value) => edit("visibleMs", value)}
        />
        <PolicyField
          key={`heartbeatMs-${resetVersion}`}
          disabled={pending || readOnly}
          field="heartbeatMs"
          value={config.heartbeatMs}
          onChange={(value) => edit("heartbeatMs", value)}
        />
      </FieldGroup>
      {dirty && baseRevision !== configRevision && (
        <Alert className="mt-5">
          <AlertDescription>
            Configuration changed elsewhere. Reload this form before saving.
          </AlertDescription>
        </Alert>
      )}
      {dirty && !readOnly && (
        <>
          <Separator className="mt-3" />
          <MotionReveal className="policy-actions">
            <Button type="submit" size="sm" disabled={pending || !dirty}>
              Save{dirty ? " changes" : ""}
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={pending}
                onClick={() => {
                  formRef.current?.focus({ preventScroll: true });
                  setDirty(false);
                  setResetVersion((v) => v + 1);
                  setConfig(service.config);
                  setBaseRevision(configRevision);
                }}
              >
                Discard
              </Button>
            )}
          </MotionReveal>
        </>
      )}
    </form>
  );
}
function ServiceAccess({
  service,
  snapshot,
  configRevision,
  mutate,
  pending,
  onCredential,
}: {
  service: Service;
  snapshot?: Snapshot;
  configRevision: number;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  }) => void;
}) {
  const runtime = snapshot ? serviceRuntime(snapshot, service) : null;
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const [revokeError, setRevokeError] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  useSemanticMotion(
    surface,
    `${service.config.enabled}:${service.config.allowInput}:${service.config.allowPreview}`,
  );
  const change = (field: string, checked: boolean) =>
    void mutate(
      `/services/${encodeURIComponent(service.id)}`,
      { expectedRevision: configRevision, config: { [field]: checked } },
      "PATCH",
    );
  const rotate = async () => {
    const value = await mutate(
      `/services/${encodeURIComponent(service.id)}/credential`,
      { expectedRevision: configRevision },
    );
    if (value)
      onCredential({
        credential: String(value.credential),
        epoch: String(value.epoch),
        epochExpiresAt: Number(value.epochExpiresAt),
        id: service.id,
      });
  };
  return (
    <Item
      ref={surface}
      data-motion-row={service.id}
      size="sm"
      role="listitem"
      className="service-access-row motion-surface"
    >
      <ItemContent className="min-w-0">
        <div className="service-access-main">
          <ItemTitle className="service-identity">
            <strong>{serviceLabel(service)}</strong>
            <span>
              {service.template === "agent"
                ? "Agent"
                : service.template === "notifier"
                  ? "Notifications"
                  : "Custom"}
            </span>
          </ItemTitle>
          <ItemActions>
            <Switch
              checked={service.config.enabled}
              disabled={pending}
              aria-label={`Enable ${service.name}`}
              onCheckedChange={(checked) => change("enabled", checked)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${service.name}`}
                    ref={actionTrigger}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={pending}
                    onClick={() => void rotate()}
                  >
                    <KeyRound />
                    Replace credential
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onClick={() => {
                      setRevokeError(false);
                      setConfirmRevoke(true);
                    }}
                  >
                    <Trash2 />
                    Revoke service
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </ItemActions>
        </div>
        {runtime && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{runtime.connection}</Badge>
            <span>{runtime.display}</span>
            <span>
              · <SettingNumber value={runtime.queued} /> queued
            </span>
            <PriorityGroupBadge group={runtime.priorityGroup} />
            <span title="Last source heartbeat">
              · {time(runtime.lastHeartbeat)}
            </span>
          </div>
        )}
        <div className="service-connections">
          <label title="Let this service forward the Bar’s Start / Pause button.">
            <span>Bar buttons</span>
            <Switch
              size="sm"
              checked={service.config.allowInput}
              disabled={pending}
              aria-label={`Bar buttons for ${service.name}`}
              onCheckedChange={(checked) => change("allowInput", checked)}
            />
          </label>
          <label title="Let this service send the Bar’s actual screen to this page. Use one Mac with local access.">
            <span>Live preview</span>
            <Switch
              size="sm"
              checked={service.config.allowPreview}
              disabled={pending}
              aria-label={`Live preview for ${service.name}`}
              onCheckedChange={(checked) => change("allowPreview", checked)}
            />
          </label>
        </div>
      </ItemContent>
      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent finalFocus={actionTrigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {serviceLabel(service)}?</AlertDialogTitle>
            <AlertDialogDescription>
              End queued items and revoke this service’s access?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <Alert variant="destructive">
              <AlertDescription>
                Could not revoke this service. Review the error and try again.
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void (async () => {
                  setRevokeError(false);
                  const result = await mutate(
                    `/services/${encodeURIComponent(service.id)}/revoke`,
                    { expectedRevision: configRevision },
                  );
                  if (result) setConfirmRevoke(false);
                  else setRevokeError(true);
                })();
              }}
            >
              Confirm revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Item>
  );
}

export function Register({
  computerId,
  revision,
  mutate,
  pending,
  onCreated,
}: {
  computerId: string;
  revision: number;
  mutate: Mutate;
  pending: boolean;
  onCreated: (value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  }) => void;
}) {
  const formId = useId();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("agent");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate("/services", {
      id,
      name: name.trim(),
      ...(computerId ? { computerId } : {}),
      template,
      expectedRevision: revision,
    });
    if (result)
      onCreated({
        id,
        credential: String(result.credential),
        epoch: String(result.epoch),
        epochExpiresAt: Number(result.epochExpiresAt),
      });
  };
  return (
    <Card className="register">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Register a service
        </CardTitle>
        <CardDescription>
          Connect a local collector or custom publisher.
        </CardDescription>
      </CardHeader>
      <form onSubmit={(event) => void submit(event)}>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${formId}-device`}>Computer</FieldLabel>
              <p
                id={`${formId}-device`}
                className="break-all text-sm text-muted-foreground"
              >
                {computerId} · This computer
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field6`}>{"Name"}</FieldLabel>
              <Input
                id={`${formId}-field6`}
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My Codex"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field7`}>
                {"Service ID"}
              </FieldLabel>
              <Input
                id={`${formId}-field7`}
                required
                pattern="[A-Za-z0-9_-]{1,64}"
                maxLength={64}
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder="codex-mac"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field8`}>{"Template"}</FieldLabel>
              <SettingsSelect
                id={`${formId}-field8`}
                value={template}
                onChange={setTemplate}
                options={[
                  { value: "agent", label: "Agent checker" },
                  { value: "notifier", label: "Notifier" },
                  { value: "custom", label: "Custom publisher" },
                ]}
              />
              <FieldDescription>
                Each message declares whether it ends with its source or after a
                fixed time. Hold sets background turns in Dispensable and the
                total lifetime of timed messages. Agents start in Dispensable;
                other templates start in Follow queue.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-5">
          <Button type="submit" disabled={pending}>
            Create service
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
