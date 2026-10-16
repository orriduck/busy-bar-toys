import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Service, Mutate } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import { Switch } from "./components/ui/switch";
import { MoreHorizontal, KeyRound, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./components/ui/dropdown-menu";
import { serviceLabel } from "./service-layout";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
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
  const [config, setConfig] = useState(service.config);
  const [dirty, setDirty] = useState(false);
  const edits = useRef(0);
  const [baseRevision, setBaseRevision] = useState(configRevision);
  useEffect(() => {
    if (!dirty) {
      setConfig(service.config);
      setBaseRevision(configRevision);
    }
  }, [service.config, configRevision, dirty]);
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
      if (edits.current === submittedEdit) setDirty(false);
      else {
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
    <Card className="service">
      <form id={formId} onSubmit={(event) => void save(event)}>
        <CardContent>
          <FieldGroup className="service-fields">
            <Field>
              <FieldLabel htmlFor={`${formId}-field1`}>{"Priority"}</FieldLabel>
              <Input
                id={`${formId}-field1`}
                type="number"
                required
                min="0"
                max="1000"
                value={config.priority}
                onChange={(event) =>
                  edit("priority", Number(event.target.value))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field2`}>{"Exit"}</FieldLabel>
              <NativeSelect
                id={`${formId}-field2`}
                value={config.exit}
                onChange={(event) => edit("exit", event.target.value)}
              >
                <NativeSelectOption value="default">
                  Automatic
                </NativeSelectOption>
                <NativeSelectOption value="finite">
                  Fixed time
                </NativeSelectOption>
                <NativeSelectOption value="source">
                  Source ends
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field3`}>{"Hold (s)"}</FieldLabel>
              <Input
                id={`${formId}-field3`}
                type="number"
                required
                min="1"
                step="any"
                max="86400"
                value={config.visibleMs / 1000}
                onChange={(event) =>
                  edit(
                    "visibleMs",
                    Math.round(Number(event.target.value) * 1000),
                  )
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field4`}>
                {"Later (min)"}
              </FieldLabel>
              <Input
                id={`${formId}-field4`}
                type="number"
                required
                min="0.016666666666666666"
                step="any"
                max="1440"
                value={config.snoozeMs / 60000}
                onChange={(event) =>
                  edit(
                    "snoozeMs",
                    Math.round(Number(event.target.value) * 60000),
                  )
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field5`}>
                {"Heartbeat (s)"}
              </FieldLabel>
              <Input
                id={`${formId}-field5`}
                type="number"
                required
                min="5"
                step="any"
                max="300"
                value={config.heartbeatMs / 1000}
                onChange={(event) =>
                  edit(
                    "heartbeatMs",
                    Math.round(Number(event.target.value) * 1000),
                  )
                }
              />
            </Field>
          </FieldGroup>
          {dirty && baseRevision !== configRevision && (
            <Alert className="mt-5">
              <AlertDescription>
                Configuration changed elsewhere. Reload this form before saving.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="service-bottom gap-2 mt-5">
          <Button type="submit" disabled={pending || !dirty}>
            Save{dirty ? " changes" : ""}
          </Button>
          {dirty && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setDirty(false);
                setConfig(service.config);
                setBaseRevision(configRevision);
              }}
            >
              Reload
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
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
    <div className="service-access-row">
      <div className="service-access-main">
        <div className="service-identity">
          <strong>{serviceLabel(service)}</strong>
          <span>
            {service.template === "agent"
              ? "Agent"
              : service.template === "notifier"
                ? "Notifications"
                : "Custom"}
          </span>
        </div>
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
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem disabled={pending} onClick={() => void rotate()}>
              <KeyRound />
              Replace credential
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onClick={() => setConfirmRevoke(true)}
            >
              <Trash2 />
              Revoke service
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
      {confirmRevoke && (
        <div
          className="service-revoke"
          role="group"
          aria-label={`Confirm revoke ${service.name}`}
        >
          <p>End queued items and revoke this service’s access?</p>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              void mutate(
                `/services/${encodeURIComponent(service.id)}/revoke`,
                { expectedRevision: configRevision },
              )
            }
          >
            Confirm revoke
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirmRevoke(false)}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

export function Register({
  revision,
  mutate,
  pending,
  onCreated,
}: {
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
  const [deviceName, setDeviceName] = useState("");
  const [template, setTemplate] = useState("agent");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate("/services", {
      id,
      name: deviceName.trim() ? `${deviceName.trim()} · ${name.trim()}` : name,
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
              <FieldLabel htmlFor={`${formId}-device`}>Device name</FieldLabel>
              <Input
                id={`${formId}-device`}
                value={deviceName}
                maxLength={40}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="MacBook"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-field6`}>{"Name"}</FieldLabel>
              <Input
                id={`${formId}-field6`}
                required
                maxLength={
                  deviceName.trim()
                    ? Math.max(1, 77 - deviceName.trim().length)
                    : 80
                }
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
              <NativeSelect
                id={`${formId}-field8`}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              >
                <NativeSelectOption value="agent">
                  Agent checker
                </NativeSelectOption>
                <NativeSelectOption value="notifier">
                  Notifier
                </NativeSelectOption>
                <NativeSelectOption value="custom">
                  Custom publisher
                </NativeSelectOption>
              </NativeSelect>
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
