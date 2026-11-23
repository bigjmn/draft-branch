/** Typed access to the main process from the page. */
import type { DeviceSettings, ProjectApi, ProjectRef } from "../../core/types";
import type { AppEvent, Request, Responses } from "../../shared/bridge";

/** A failure reported by the main process. `message` is safe to show. */
export class DeviceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}

export async function device<K extends Request["kind"]>(
  request: Extract<Request, { kind: K }>,
): Promise<Responses[K]> {
  const bridge = window.draftbranchDesktop;
  if (!bridge)
    throw new DeviceError(
      "DraftBranch desktop features are unavailable in this window.",
    );
  const reply = await bridge.invoke(request);
  if (!reply.ok) throw new DeviceError(reply.error.message, reply.error.code);
  return reply.value as Responses[K];
}
export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  return window.draftbranchDesktop?.on(listener) ?? (() => {});
}
export const isMac = () => window.draftbranchDesktop?.platform === "darwin";

/** One project's repository, as a plain object whose methods cross to the main process. */
export function projectApi(ref: ProjectRef): ProjectApi {
  return new Proxy({} as ProjectApi, {
    get:
      (_target, method: string) =>
      (...args: unknown[]) =>
        device({
          kind: "project.call",
          ref,
          method: method as keyof ProjectApi,
          args,
        }),
  });
}

let settings: Promise<DeviceSettings> | null = null;
export function deviceSettings(): Promise<DeviceSettings> {
  return (settings ??= device({ kind: "settings.get" }));
}
export async function updateDeviceSettings(
  patch: Partial<Pick<DeviceSettings, "writerName">>,
) {
  const next = device({ kind: "settings.set", patch });
  settings = next;
  return next;
}
