import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
/** Whether the computer has a network connection (not whether the cloud answers). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
/** False in a build made without a Firebase API key: local projects only. */
export const cloudConfigured: boolean = __DRAFTBRANCH_CLOUD__;
