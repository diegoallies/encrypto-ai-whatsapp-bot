// The bot's owner identity is configured at setup time (see setup/onboarding).
// Everything that used to hard-code a name now reads it from here so the repo
// stays free of any one person's details.
export function ownerName() {
  return process.env.OWNER_NAME || 'the owner';
}
