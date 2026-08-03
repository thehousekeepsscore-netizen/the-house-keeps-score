// Firebase-shaped-but-not-Firebase user object, kept field-compatible with
// the old `firebase/auth` User (uid/displayName/email/phoneNumber) so
// components migrated in a later phase don't need logic changes yet —
// only their `User` import path needs to change.
export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  phoneNumber: string | null;
  photoURL: string | null;
  themePreference: string;
  isSuperAdmin: boolean;
  profileComplete: boolean;
}
