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
import { Checkbox } from "./components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "./components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
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
  const [confirmRevoke, setConfirmRevoke] = useState(false);
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
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}`,
      { expectedRevision: baseRevision, config },
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
  const rotate = async () => {
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}/credential`,
      { expectedRevision: configRevision },
    );
    if (result)
      onCredential({
        credential: String(result.credential),
        epoch: String(result.epoch),
        epochExpiresAt: Number(result.epochExpiresAt),
        id: service.id,
      });
  };
  if (mode === "access")
    return (
      <Card className="service service-access">
        <CardHeader>
          <CardTitle role="heading" aria-level={3}>
            {service.name}
          </CardTitle>
          <CardDescription>
            {service.template} · {service.id}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="muted">
            Publisher expires{" "}
            {new Date(service.epochExpiresAt).toLocaleDateString()}.
          </p>
        </CardContent>
        <CardFooter className="access-actions flex-wrap gap-2">
          <Button
            variant="secondary"
            type="button"
            disabled={pending}
            onClick={() => void rotate()}
          >
            Replace credential
          </Button>
          {confirmRevoke ? (
            <>
              <span>End this service’s queued items and revoke access?</span>
              <Button
                type="button"
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
                variant="secondary"
                type="button"
                onClick={() => setConfirmRevoke(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke service
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  return (
    <Card className="service">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          {service.name}
        </CardTitle>
        <CardDescription>
          {service.template} · {service.id}
        </CardDescription>
        <CardAction>
          <Switch
            checked={config.enabled}
            aria-label={`Enable ${service.name}`}
            onCheckedChange={(checked) => edit("enabled", checked)}
          />
        </CardAction>
      </CardHeader>
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
          <FieldSet className="mt-5">
            <FieldLegend variant="label">Bridges</FieldLegend>
            <FieldGroup>
              <Field orientation="horizontal">
                <Checkbox
                  id={`${formId}-input`}
                  checked={"allowInput" in config && Boolean(config.allowInput)}
                  onCheckedChange={(checked) => edit("allowInput", checked)}
                />
                <FieldLabel htmlFor={`${formId}-input`}>
                  Trusted device button bridge
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id={`${formId}-preview`}
                  checked={config.allowPreview === true}
                  onCheckedChange={(checked) => edit("allowPreview", checked)}
                />
                <FieldLabel htmlFor={`${formId}-preview`}>
                  Live display preview bridge
                </FieldLabel>
              </Field>
            </FieldGroup>
            <FieldDescription>
              Use one Mac with local Wi-Fi access to the Bar.
            </FieldDescription>
          </FieldSet>
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
  const [template, setTemplate] = useState("agent");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate("/services", {
      id,
      name,
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
