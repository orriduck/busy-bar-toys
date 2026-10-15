/** Fence asynchronous work to the verified device and the login that started it. */
export class SessionFence {
  generation = 0;
  deviceId: string | null = null;
  private revision = -1;
  reset(deviceId: string | null): number {
    this.generation++;
    this.deviceId = deviceId;
    this.revision = -1;
    return this.generation;
  }
  current(generation: number): boolean {
    return this.generation === generation;
  }
  accept(deviceId: string, revision: number, generation: number): boolean {
    if (
      !this.current(generation) ||
      !this.deviceId ||
      deviceId !== this.deviceId ||
      !Number.isSafeInteger(revision) ||
      revision < this.revision
    )
      return false;
    this.revision = revision;
    return true;
  }
}
