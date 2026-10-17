// Usernames: 3-16 letters A-Z/a-z and digits, the Mystic Paradox backend's rule (it is also the
// in-game name). Uniqueness (case-insensitive) is the server's job; this is the live check in the form.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

export type UsernameCheck = "ok" | "empty" | "too_short" | "too_long" | "bad_chars";

export function checkUsername(input: unknown): UsernameCheck {
  if (typeof input !== "string" || input.length === 0) return "empty";
  if (!/^[A-Za-z0-9]*$/.test(input)) return "bad_chars";
  if (input.length < USERNAME_MIN) return "too_short";
  if (input.length > USERNAME_MAX) return "too_long";
  return "ok";
}

export function isValidUsername(input: unknown): input is string {
  return checkUsername(input) === "ok";
}

export function isValidPassword(input: unknown): input is string {
  return typeof input === "string" && input.length >= PASSWORD_MIN && input.length <= PASSWORD_MAX;
}
