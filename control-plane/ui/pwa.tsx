import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";

export function registerAppWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .catch(() => {
          // Installation is optional; controls continue through the network.
          console.warn("BTC offline shell could not be installed.");
        });
    },
    { once: true },
  );
}
export function OfflineNotice() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online ? null : (
    <Alert className="offline-notice" role="status">
      <AlertDescription>
        Offline. Live display and controls need a connection.
      </AlertDescription>
    </Alert>
  );
}
export function InstallApp() {
  return (
    <div className="pwa-install">
      <Dialog>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <Download data-icon="inline-start" />
          Install BTC
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install BTC</DialogTitle>
            <DialogDescription>
              Open BTC directly from your Home Screen or desktop.
            </DialogDescription>
          </DialogHeader>
          <p>
            On iPhone or iPad, open this site in Safari, tap Share, then Add to
            Home Screen. Keep Open as Web App enabled if shown.
          </p>
          <p>
            On desktop or Android, use your browser’s Install app or Add to Home
            Screen menu.
          </p>
          <p className="field-hint">
            The app shell works offline. Your live display and controls require
            a connection. You may need to sign in again after installation.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
