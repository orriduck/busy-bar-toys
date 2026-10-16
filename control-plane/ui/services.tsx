import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Service, Mutate } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
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
import { PolicyField } from "./policy-field";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
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
export function ServiceEditor({
  service,
  configRevision,
  mutate,
  pending,
  onCredential,
  mode = "policy",
}: {
  service: Service;
  mode?: "policy" | "access";
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
    service.config.priority,
    service.config.visibleMs,
    service.config.snoozeMs,
    service.config.heartbeatMs,
    service.config.exit,
  ].join(":");
  const lastPolicy = useRef(remotePolicy);
  const [baseRevision, setBaseRevision] = useState(configRevision);
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
    const submittedEdit = edits.current;
    const {
      enabled: _enabled,
      allowInput: _input,
      allowPreview: _preview,
      ...policy
    } = config;
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}`,
      { expectedRevision: baseRevision, config: policy },
      "PATCH",
    );
    if (result) {
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
        configRevision={configRevision}
        mutate={mutate}
        pending={pending}
        onCredential={onCredential}
      />
    );
  return (
    <form
      ref={formRef}
      tabIndex={-1}
      aria-label={`${serviceLabel(service)} settings`}
      className="policy-card @container/policy outline-none"
      id={formId}
      onSubmit={(event) => void save(event)}
    >
      <FieldGroup className="grid grid-cols-1 gap-x-8 gap-y-4 @2xl/policy:grid-cols-2">
        <PolicyField
          key={`priority-${resetVersion}`}
          field="priority"
          value={config.priority}
          onChange={(value) => edit("priority", value)}
        />
        <PolicyField
          key={`visibleMs-${resetVersion}`}
          field="visibleMs"
          value={config.visibleMs}
          onChange={(value) => edit("visibleMs", value)}
        />
        <PolicyField
          key={`snoozeMs-${resetVersion}`}
          field="snoozeMs"
          value={config.snoozeMs}
          onChange={(value) => edit("snoozeMs", value)}
        />
        <PolicyField
          key={`heartbeatMs-${resetVersion}`}
          field="heartbeatMs"
          value={config.heartbeatMs}
          onChange={(value) => edit("heartbeatMs", value)}
        />
        <Field className="grid min-w-0 items-center gap-2 @2xl/policy:col-span-2 @2xl/policy:grid-cols-[7rem_minmax(0,1fr)]">
          <div className="flex h-10 items-center">
            <FieldLabel id={`${formId}-exit-label`} htmlFor={`${formId}-exit`}>
              Exit
            </FieldLabel>
          </div>
          <FieldContent className="min-w-0">
            <div className="@2xl/policy:hidden">
              <SettingsSelect
                id={`${formId}-exit`}
                size="sm"
                value={config.exit}
                onChange={(value) => edit("exit", value)}
                options={[
                  { value: "default", label: "Automatic" },
                  { value: "finite", label: "Fixed time" },
                  { value: "source", label: "Source ends" },
                ]}
              />
            </div>
            <Tabs
              className="hidden @2xl/policy:flex"
              value={config.exit}
              onValueChange={(value) => edit("exit", value)}
            >
              <TabsList
                size="lg"
                className="w-fit"
                aria-labelledby={`${formId}-exit-label`}
              >
                <TabsTrigger value="default">Automatic</TabsTrigger>
                <TabsTrigger value="finite">Fixed time</TabsTrigger>
                <TabsTrigger value="source">Source ends</TabsTrigger>
              </TabsList>
              <TabsContent value="default" className="sr-only">
                Use each message’s default display duration.
              </TabsContent>
              <TabsContent value="finite" className="sr-only">
                Use the Hold duration for each message.
              </TabsContent>
              <TabsContent value="source" className="sr-only">
                Display until the sender finishes.
              </TabsContent>
            </Tabs>
          </FieldContent>
        </Field>
      </FieldGroup>
      {dirty && baseRevision !== configRevision && (
        <Alert className="mt-5">
          <AlertDescription>
            Configuration changed elsewhere. Reload this form before saving.
          </AlertDescription>
        </Alert>
      )}
      {dirty && (
        <>
          <Separator className="mt-3" />
          <div className="policy-actions">
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
          </div>
        </>
      )}
    </form>
  );
}
function ServiceAccess({
  service,
  configRevision,
  mutate,
  pending,
  onCredential,
}: {
  service: Service;
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
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const [revokeError, setRevokeError] = useState(false);
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
    <Item size="sm" role="listitem" className="service-access-row">
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
  services,
  revision,
  mutate,
  pending,
  onCreated,
}: {
  services: Service[];
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
  const [computerId, setComputerId] = useState("");
  const [template, setTemplate] = useState("agent");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate("/services", {
      id,
      name: name.trim(),
      ...(computerId ? { computerId } : {}),
      template,
      expectedRevision: revision,
      config: { priority: template === "agent" ? 10 : 50 },
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
              <SettingsSelect
                id={`${formId}-device`}
                value={computerId}
                onChange={setComputerId}
                options={[
                  { value: "", label: "New computer (generate ID)" },
                  ...[
                    ...new Set(
                      services
                        .map((s) => s.computerId)
                        .filter((id): id is string => !!id),
                    ),
                  ].map((id) => ({ value: id, label: id })),
                ]}
              />
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
