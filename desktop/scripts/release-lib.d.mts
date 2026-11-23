export function installerNames(version: string): { mac: string; win: string };
export function installerPlatform(fileName: string): "mac" | "win" | null;
export function developerId(codesignOutput: string): string | null;
export function macVerdict(facts: {
  signedBy: string | null;
  signatureValid: boolean;
  notarized: boolean;
}): { publishable: boolean; status: string };
export function hasWindowsSignature(header: Buffer): boolean;
export function megabytes(bytes: number): string;
export function maskSecrets(text: string): string;
