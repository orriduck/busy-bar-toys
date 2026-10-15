import type { QueueItem, Snapshot } from "./api";

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
  const name = service?.name || item.serviceId;
  const shared = snapshot.items.some(
    (other) =>
      other.serviceId === item.serviceId &&
      other.instanceId !== item.instanceId,
  );
  const sender =
    shared && !name.toLowerCase().includes(item.instanceId.toLowerCase())
      ? `${name} / ${item.instanceId}`
      : name;
  return { app, appId, sender, receivedAt: item.receivedAt };
}
