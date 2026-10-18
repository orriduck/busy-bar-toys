import { useRef, useState } from "react";
import { BROWSER_SESSION_DAYS } from "../session-policy";
import type { FormEvent } from "react";
import { api, message } from "./api";
import { useMutation } from "@tanstack/react-query";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Alert, AlertDescription } from "./components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
export function SignIn({
  demo,
  onSignIn,
  onError,
}: {
  demo: boolean;
  onSignIn: (deviceId: string, demo: boolean | undefined) => void;
  onError: (error: string) => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const login = useMutation({
    mutationFn: (token: string) =>
      api<{ deviceId: string; demo?: boolean }>("/session", { token }),
    retry: false,
    gcTime: 0,
  });
  const busy = login.isPending;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onError("");
    setError("");
    try {
      const result = await login.mutateAsync(token);
      setToken("");
      onSignIn(result.deviceId, result.demo);
    } catch (e) {
      setError(message(e));
      onError(message(e));
    } finally {
      login.reset();
    }
  };
  return (
    <section className="signin">
      <h1>Connect your BUSY Bar</h1>
      <p>
        Connect your BUSY Bar to manage display services and see what is next.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="device-token">Device API token</FieldLabel>
            <Input
              id="device-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
              maxLength={4096}
              placeholder={
                demo ? "demo-token" : "Device-scoped BUSY cloud token"
              }
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            Stay signed in on this browser for {BROWSER_SESSION_DAYS} days.
            Signing out or clearing site data ends this session earlier.
          </p>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect device"}
          </Button>
        </FieldGroup>
      </form>
      <p className="muted">
        The backend verifies your device and stores the token encrypted. This
        browser uses a separate session cookie.
      </p>
      {demo && (
        <p className="demo-hint">
          Demo only: enter <code>demo-token</code>. The mock device cannot write
          to real hardware.
        </p>
      )}
    </section>
  );
}
export function Credential({
  value,
  template,
  setupMode,
  onClose,
}: {
  value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  };
  template?: string;
  setupMode: "unknown" | "public-demo" | "allowed";
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const prior = useRef(document.activeElement);
  const restoreFocus = () => {
    const target = prior.current;
    return target instanceof HTMLElement &&
      target !== document.body &&
      target.isConnected &&
      !target.closest("[hidden]")
      ? target
      : document.querySelector<HTMLButtonElement>(
          'nav button[aria-current="page"]',
        );
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value.credential);
      setCopied(true);
    } catch {
      setCopyError(
        "Clipboard unavailable. Select and copy the credential below.",
      );
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="credential max-h-[90dvh] overflow-y-auto"
        initialFocus={closeRef}
        finalFocus={restoreFocus}
      >
        <DialogHeader>
          <DialogTitle id="credential-title">Connect {value.id}</DialogTitle>
          <DialogDescription>
            Save this publisher credential now. It is shown only once.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="publisher-credential">
              Publisher credential
            </FieldLabel>
            <Textarea
              id="publisher-credential"
              readOnly
              rows={3}
              value={value.credential}
              spellCheck={false}
            />
          </Field>
        </FieldGroup>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy credential"}
        </Button>
        {copyError && (
          <Alert variant="destructive">
            <AlertDescription>{copyError}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="publisher-epoch">Epoch</FieldLabel>
            <Input id="publisher-epoch" readOnly value={value.epoch} />
          </Field>
        </FieldGroup>
        <p className="muted">
          Expires {new Date(value.epochExpiresAt).toLocaleString()}. Keep this{" "}
          {setupMode !== "allowed"
            ? "credential for synthetic publishers only."
            : "credential in your local Keychain."}{" "}
          It cannot access the BUSY token.
        </p>
        {setupMode === "unknown" ? (
          <p>
            Server mode is unverified. Reload before connecting a collector.
          </p>
        ) : setupMode === "public-demo" ? (
          <p>
            Public demo: use synthetic data only. Do not connect a real Mac
            collector.
          </p>
        ) : template === "agent" || template === "notifier" ? (
          <>
            <p>
              Run this command on the source Mac. Paste the credential at the
              hidden prompt. The client reads its epoch automatically.
            </p>
            <pre className="setup-command">{`busy-bar cloud-setup --url ${location.origin} --role ${template}`}</pre>
            <p className="muted">
              Setup saves this connection. It does not replace the running
              standalone service.
            </p>
          </>
        ) : (
          <p>
            Use the{" "}
            <a
              href="https://github.com/orriduck/busy-bar-toys/blob/main/control-plane/PROTOCOL.md"
              target="_blank"
              rel="noreferrer"
            >
              publisher protocol
            </a>{" "}
            to connect a custom service. Keep the credential in your local
            secret store.
          </p>
        )}
        <DialogFooter>
          <Button ref={closeRef} onClick={onClose}>
            I saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
