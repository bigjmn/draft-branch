/** Compile-time proof that the on-device data layer offers everything the web
 * app's project client does, with signatures the shared components can call.
 * If the web client gains or changes an export, `npm run typecheck` fails here
 * until client.ts follows. */
import type * as web from "../../../../src/lib/projects/client";
import type * as desktop from "./client";

type Web = typeof web;
type Desktop = typeof desktop;
type Missing = Exclude<keyof Web, keyof Desktop>;
type Incompatible = {
  [K in keyof Web & keyof Desktop]: Desktop[K] extends Web[K] ? never : K;
}[keyof Web & keyof Desktop];

export const clientContract: [Missing, Incompatible] extends [never, never]
  ? true
  : { missing: Missing; incompatible: Incompatible } = true;
