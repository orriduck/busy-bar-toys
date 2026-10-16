import { useState } from "react";
import type { Mutate } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./components/ui/dialog";
import { Field, FieldLabel } from "./components/ui/field";
import { Link2 } from "lucide-react";
/** The server's pairing proof is the only authority. Device-key login is view-only. */
export function ComputerAccess({
  ownerComputerId,
  mutate,
  pending,
  onPaired,
}: {
  ownerComputerId: string | null;
  mutate: Mutate;
  pending: boolean;
  onPaired: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [code, setCode] = useState("");
  const [ticket, setTicket] = useState<{
    enrollment: string;
    expiresAt: number;
  } | null>(null);
  return (
    <div className="computer-access">
      <span>
        {ownerComputerId ? (
          <>
            <Badge variant="secondary">This computer</Badge>{" "}
            <span title={ownerComputerId}>{ownerComputerId.slice(0, 8)}</span>
          </>
        ) : (
          "Monitoring · pair this browser to manage your computer’s services."
        )}
      </span>
      {!ownerComputerId && (
        <Dialog
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) {
              setTicket(null);
              setCode("");
            }
          }}
        >
          <DialogTrigger render={<Button size="sm" variant="outline" />}>
            <Link2 />
            {ownerComputerId ? "Pair another computer" : "Connect computer"}
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Connect this computer</DialogTitle>
              <DialogDescription>
                A device key shows every computer. Pairing grants access only to
                services owned by the computer that issued the code.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  const result = await mutate("/session/computer", {
                    code: code.trim(),
                  });
                  if (typeof result?.computerId === "string") {
                    onPaired(result.computerId);
                    setCode("");
                    setOpen(false);
                  }
                })();
              }}
            >
              <p className="text-sm text-muted-foreground">
                On the Mac that runs your services, run{" "}
                <code>busy-bar cloud-pair</code>. Paste its one-use code below.
              </p>
              <Field>
                <FieldLabel htmlFor="computer-pair-code">
                  Pairing code
                </FieldLabel>
                <Input
                  id="computer-pair-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pair.…"
                  required
                />
              </Field>
              <Button type="submit" disabled={pending || !code.trim()}>
                Pair browser
              </Button>
            </form>
            {!ownerComputerId && (
              <div className="grid gap-3 border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">
                  New computer? Create a five-minute enrollment ticket, then run{" "}
                  <code>
                    busy-bar cloud-enroll --url {window.location.origin}
                  </code>{" "}
                  and paste the ticket into its private prompt.
                </p>
                {!ticket ? (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      void (async () => {
                        const result = await mutate(
                          "/computers/enrollment",
                          {},
                        );
                        if (
                          typeof result?.enrollment === "string" &&
                          typeof result.expiresAt === "number"
                        )
                          setTicket({
                            enrollment: result.enrollment,
                            expiresAt: result.expiresAt,
                          });
                      })()
                    }
                  >
                    Create enrollment ticket
                  </Button>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="computer-enrollment">
                      One-use ticket · expires{" "}
                      {new Date(ticket.expiresAt).toLocaleTimeString()}
                    </FieldLabel>
                    <Input
                      id="computer-enrollment"
                      readOnly
                      value={ticket.enrollment}
                      onFocus={(event) => event.target.select()}
                    />
                    <p className="text-sm text-muted-foreground">
                      After enrollment, run cloud-pair to connect this browser.
                    </p>
                  </Field>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
