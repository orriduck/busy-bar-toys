import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, message } from "./api";
export function SignIn({
  demo,
  onSignIn,
  onError,
}: {
  demo: boolean;
  onSignIn: (deviceId: string) => void;
  onError: (error: string) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError("");
    try {
      const result = await api<{ deviceId: string }>("/session", { token });
      setToken("");
      onSignIn(result.deviceId);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="signin">
      <div className="signin-rule" />
      <h1>
        One display.
        <br />
        Everything in order.
      </h1>
      <p>
        Connect your BUSY Bar to manage display services and see what is next.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="device-token">Device API token</label>
        <input
          id="device-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          maxLength={4096}
          placeholder={demo ? "demo-token" : "Device-scoped BUSY cloud token"}
        />
        <button className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect device"}
        </button>
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
    </main>
  );
}
export function Credential({
  value,
  template,
  onClose,
}: {
  value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  };
  template?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (prior instanceof HTMLElement) prior.focus();
    };
  }, []);
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
    <div className="modal-backdrop">
      <section
        className="credential"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const nodes = event.currentTarget.querySelectorAll<HTMLElement>(
              "button,textarea,input",
            );
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="credential-title">Connect {value.id}</h2>
        <p>Save this publisher credential now. It is shown only once.</p>
        <label>
          Publisher credential
          <textarea
            readOnly
            rows={3}
            value={value.credential}
            spellCheck={false}
          />
        </label>
        <button onClick={() => void copy()}>
          {copied ? "Copied" : "Copy credential"}
        </button>
        {copyError && <p role="alert">{copyError}</p>}
        <label>
          Epoch
          <input readOnly value={value.epoch} />
        </label>
        <p className="muted">
          Expires {new Date(value.epochExpiresAt).toLocaleString()}. Keep this
          credential in your local Keychain. It cannot access the BUSY token.
        </p>
        {template === "agent" || template === "notifier" ? (
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
              href="https://github.com/orriduck/busy-bar-toys/blob/feat/control-plane/control-plane/PROTOCOL.md"
              target="_blank"
              rel="noreferrer"
            >
              publisher protocol
            </a>{" "}
            to connect a custom service. Keep the credential in your local
            secret store.
          </p>
        )}
        <button ref={closeRef} className="primary" onClick={onClose}>
          I saved it
        </button>
      </section>
    </div>
  );
}
