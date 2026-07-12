export const LAUNCH_MARKER = "[[LAUNCH]]";

export function containsLaunchMarker(text: string): boolean {
  return text.includes(LAUNCH_MARKER);
}

export function stripLaunchMarker(text: string): string {
  return text.split(LAUNCH_MARKER).join("").trimEnd();
}
