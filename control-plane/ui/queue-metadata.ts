import type { QueueItem, Snapshot } from "./api";
import { serviceLabel } from "./service-layout";

const apps: Record<string, string> = {
  codex: "Codex",
  chatgpt: "ChatGPT",
  dots: "Your dot",
  claude: "Claude Code",
  adsbao: "ADSBao",
  github: "GitHub",
  datadog: "Datadog",
  jira: "Jira",
  metaflow: "Metaflow",
  terminal: "Terminal",
  credentials: "Credentials",
  calendar: "Calendar",
};

/** Notification text is never used to infer its app or its author. */
export function queueMetadata(item: QueueItem, snapshot: Snapshot) {
  const service = snapshot.services.find((s) => s.id === item.serviceId);
  const supplied = item.app?.trim();
  const appId = supplied?.toLowerCase() || service?.template || "custom";
  const app = supplied
    ? apps[appId] || supplied
    : service?.template === "agent"
      ? "Agent checker"
      : service?.template === "notifier"
        ? "Notifier"
        : service?.name || "Unknown app";
  const name = service ? serviceLabel(service) : item.serviceId;
  const sender = `${service?.computerId || item.instanceId} · ${name}`;
  return { app, appId, sender, receivedAt: item.receivedAt };
}

/** Compact table label; detailed provenance and the source identity stay intact. */
export function compactSender(sender: string) {
  const separator = sender.indexOf(" · ");
  return separator < 0
    ? sender
    : sender.slice(0, separator).slice(0, 8) + sender.slice(separator);
}
